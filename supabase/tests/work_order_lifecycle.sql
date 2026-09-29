begin;
select plan(60);

-- Fixtures: one tenant with a manager and three workers, and a second tenant
-- whose manager must not reach the first tenant's work.
insert into public.tenant (id, name) values
  ('00000000-0000-0000-0000-0000000000c0', 'Lifecycle test'),
  ('00000000-0000-0000-0000-0000000000d0', 'Lifecycle other tenant');
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000c1', 'lifecycle-manager@example.com',
   '{"tenant_id":"00000000-0000-0000-0000-0000000000c0","role":"manager","display_name":"Lifecycle Manager"}'),
  ('00000000-0000-0000-0000-0000000000c2', 'lifecycle-alice@example.com',
   '{"tenant_id":"00000000-0000-0000-0000-0000000000c0","role":"worker","display_name":"Alice Worker"}'),
  ('00000000-0000-0000-0000-0000000000c3', 'lifecycle-bob@example.com',
   '{"tenant_id":"00000000-0000-0000-0000-0000000000c0","role":"worker","display_name":"Bob Worker"}'),
  ('00000000-0000-0000-0000-0000000000c4', 'lifecycle-carol@example.com',
   '{"tenant_id":"00000000-0000-0000-0000-0000000000c0","role":"worker","display_name":"Carol Worker"}'),
  ('00000000-0000-0000-0000-0000000000d1', 'lifecycle-other@example.com',
   '{"tenant_id":"00000000-0000-0000-0000-0000000000d0","role":"manager","display_name":"Other Manager"}');

create function pg_temp.worker(p_user text) returns bigint language sql as $$
  select worker_id from public.user_profile
  where id = ('00000000-0000-0000-0000-0000000000' || p_user)::uuid
$$;
create function pg_temp.act_as(p_user text) returns text language sql as $$
  select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000' || p_user, true)
$$;
create function pg_temp.order_id(p_number text) returns bigint language sql as $$
  select id from public.work_order
  where tenant_id = '00000000-0000-0000-0000-0000000000c0' and work_order_number = p_number
$$;
create function pg_temp.task(p_description text) returns bigint language sql as $$
  select id from public.task
  where tenant_id = '00000000-0000-0000-0000-0000000000c0' and description = p_description
$$;
create function pg_temp.notices(p_user text, p_subject text, p_channel text default 'in_app')
returns bigint language sql as $$
  select count(*) from public.notification
  where recipient_user_id = ('00000000-0000-0000-0000-0000000000' || p_user)::uuid
    and subject = p_subject and channel = p_channel::public.notification_channel
$$;

select pg_temp.act_as('c1');
select public.create_work_order_bundle($$
  {"clientName":"Lifecycle Client","streetAddress":"1 Test St","suburb":"Saratgoa",
   "state":"NSW","postcode":"2251","workOrderNumber":"LC-1","siteContactName":"Site Person",
   "siteContactPhone":"0400000000","subtotalCents":150000,"gstRate":0,"gstCents":0,
   "totalCents":150000,"totalOverride":true,
   "tasks":[
     {"trade":"Painting","area":"Lounge","description":"Paint walls","quantity":40,"unit":"m2"},
     {"trade":"Painting","area":"Lounge","description":"Paint skirting","quantity":20,"unit":"lm"},
     {"trade":"Carpentry","area":"","description":"Replace door","quantity":1,"unit":"ea"}
   ]}
$$::jsonb);

-- ---------------------------------------------------------------------------
-- Whole-order crew assignment
-- ---------------------------------------------------------------------------

select is(
  public.assign_work_order_crew(pg_temp.order_id('LC-1'), array[pg_temp.worker('c2'), pg_temp.worker('c3')], pg_temp.worker('c3'), null) ->> 'crewSize',
  '2', 'A whole order can be assigned to two workers at once');
select is(
  (select count(*) from public.assignment a join public.task t on t.id = a.task_id
   where t.work_order_id = pg_temp.order_id('LC-1') and a.status <> 'reassigned'),
  6::bigint, 'Every job gets every crew member');
select is(
  (select count(*) from public.assignment a join public.task t on t.id = a.task_id
   where t.work_order_id = pg_temp.order_id('LC-1') and a.is_lead and a.worker_id = pg_temp.worker('c3')),
  3::bigint, 'The chosen lead leads every job');
select is(
  (select lead_worker_id from public.work_order where id = pg_temp.order_id('LC-1')),
  pg_temp.worker('c3'), 'The order records its lead');
select is(
  (select count(*) from public.task where work_order_id = pg_temp.order_id('LC-1') and status = 'assigned'),
  3::bigint, 'Without dates the jobs are assigned, not scheduled');
select is(pg_temp.notices('c2', 'New work assigned'), 1::bigint,
  'Each new crew member gets one message for the whole order');

select is(
  public.assign_work_order_crew(pg_temp.order_id('LC-1'), array[pg_temp.worker('c2'), pg_temp.worker('c3')], pg_temp.worker('c3'),
    array[public.business_today() + 1, public.business_today() + 2]) ->> 'scheduledDays',
  '2', 'Optional work days can be chosen');
select is(
  (select count(*) from public.schedule_entry where work_order_id = pg_temp.order_id('LC-1')),
  4::bigint, 'Each crew member is booked on each chosen day');
select is(
  (select status::text from public.work_order where id = pg_temp.order_id('LC-1')),
  'scheduled', 'An order with work days is scheduled');

create temp table crew_change as
select public.assign_work_order_crew(
  pg_temp.order_id('LC-1'), array[pg_temp.worker('c2'), pg_temp.worker('c4')], pg_temp.worker('c2'), null) as r;
select is((select r ->> 'removedWorkers' from crew_change) || '/' || (select r ->> 'addedWorkers' from crew_change),
  '1/1', 'Changing the crew reports who left and who joined');
select is(
  (select count(*) from public.assignment a join public.task t on t.id = a.task_id
   where t.work_order_id = pg_temp.order_id('LC-1') and a.worker_id = pg_temp.worker('c3') and a.status <> 'reassigned'),
  0::bigint, 'A worker removed from the crew loses every job on the order');
select is(
  (select count(*) from public.schedule_entry where worker_id = pg_temp.worker('c3')),
  0::bigint, 'A worker removed from the crew comes off the days ahead');
select is(
  (select count(*) from public.schedule_entry
   where work_order_id = pg_temp.order_id('LC-1') and worker_id = pg_temp.worker('c4')),
  2::bigint, 'A worker joining without new dates inherits the order''s days ahead');
select is(pg_temp.notices('c3', 'Work unassigned'), 1::bigint, 'The removed worker is told once');
select throws_ok(
  format('select public.assign_work_order_crew(%s, array[%s], %s, null)',
    pg_temp.order_id('LC-1'), pg_temp.worker('c2'), pg_temp.worker('c3')),
  'P0001', 'Choose the lead from the selected workers', 'The lead must be one of the crew');
select throws_ok(
  format('select public.assign_work_order_crew(%s, array[999999::bigint], null, null)', pg_temp.order_id('LC-1')),
  'P0001', 'One or more of the chosen workers is unavailable', 'Unknown workers are rejected');

-- ---------------------------------------------------------------------------
-- Adding a job to a saved order
-- ---------------------------------------------------------------------------

select is(
  public.add_work_order_task(pg_temp.order_id('LC-1'), 'Painting', 'Paint ceiling', 12, 'm2', 'Kitchen') ->> 'assignedWorkers',
  '2', 'A new job goes to the whole crew');
select is(
  (select status::text from public.task where id = pg_temp.task('Paint ceiling')),
  'scheduled', 'A new job on an order with days ahead is scheduled');
select is(
  (select worker_id from public.assignment where task_id = pg_temp.task('Paint ceiling') and is_lead),
  pg_temp.worker('c2'), 'The order lead leads the new job');

-- ---------------------------------------------------------------------------
-- Manager completion, archive and reopen
-- ---------------------------------------------------------------------------

select is(
  public.complete_work_order_tasks(pg_temp.order_id('LC-1'), array[pg_temp.task('Replace door')]) ->> 'completedTasks',
  '1', 'A manager can complete a single job');
select is(
  (select status::text from public.work_order where id = pg_temp.order_id('LC-1')),
  'scheduled', 'The order stays active while other jobs are open');

-- Alice sends one job in from the field before the manager closes the order.
select pg_temp.act_as('c2');
select public.worker_start_task(pg_temp.task('Paint ceiling'));
select public.worker_submit_completion(pg_temp.task('Paint ceiling'), 'Done', false, null);
select pg_temp.act_as('c1');

create temp table completion as
select public.complete_work_order_tasks(pg_temp.order_id('LC-1'), null) as r;
select is((select r ->> 'completedTasks' from completion), '3', 'Completing the order closes every open job');
select is((select r ->> 'approvedSubmissions' from completion), '1',
  'A pending field submission is approved rather than left in Review');
select is(
  (select status::text from public.work_order where id = pg_temp.order_id('LC-1')),
  'signed_off', 'A fully complete order is signed off');
select ok(
  (select completed_at is not null from public.work_order where id = pg_temp.order_id('LC-1')),
  'Signing off records when the order was completed');
select is(
  (select count(*) from public.schedule_entry
   where work_order_id = pg_temp.order_id('LC-1') and planned_date > public.business_today()),
  0::bigint, 'A completed order leaves no days ahead on the calendar');
select is(pg_temp.notices('c4', 'Work order completed'), 1::bigint, 'The crew hears the order is complete');
select is(pg_temp.notices('c4', 'Work order completed', 'email'), 0::bigint, 'Completion is in-app only');
select is(
  public.complete_work_order_tasks(pg_temp.order_id('LC-1'), null) ->> 'completedTasks',
  '0', 'Completing an already complete order changes nothing');
select throws_ok(
  format('select public.assign_work_order_crew(%s, array[%s], null, null)', pg_temp.order_id('LC-1'), pg_temp.worker('c2')),
  'P0001', 'Reopen the work order before changing its crew', 'A completed order keeps its crew');

select is(
  public.reopen_work_order(pg_temp.order_id('LC-1'), 'Client asked for touch-ups') ->> 'workOrderStatus',
  'assigned', 'Reopening returns the order to active work');
select ok(
  (select completed_at is null from public.work_order where id = pg_temp.order_id('LC-1')),
  'Reopening clears the completion time');
select throws_ok(
  format('select public.reopen_work_order(%s, null)', pg_temp.order_id('LC-1')),
  'P0001', 'Only completed work orders can be reopened', 'Only completed orders reopen');

-- ---------------------------------------------------------------------------
-- Deleting jobs
-- ---------------------------------------------------------------------------

-- Give the skirting job field evidence: a submission, a photo and a note.
select pg_temp.act_as('c2');
select public.worker_start_task(pg_temp.task('Paint skirting'));
select public.worker_submit_completion(pg_temp.task('Paint skirting'), 'Skirting done', false, null);
select pg_temp.act_as('c1');
insert into public.completion_photo (
  tenant_id, completion_submission_id, storage_key, thumbnail_key, content_type, size_bytes, uploaded_by
)
select tenant_id, id, 'photos/lc-skirting.jpg', 'photos/lc-skirting-thumb.jpg', 'image/jpeg', 1000,
  '00000000-0000-0000-0000-0000000000c2'
from public.completion_submission where task_id = pg_temp.task('Paint skirting');
insert into public.note (tenant_id, parent_type, parent_id, author_user_id, body)
values ('00000000-0000-0000-0000-0000000000c0', 'task', pg_temp.task('Paint skirting'),
  '00000000-0000-0000-0000-0000000000c1', 'Check the corners');

create temp table deleted_skirting as
select pg_temp.task('Paint skirting') as task_id, public.delete_task(pg_temp.task('Paint skirting')) as r;
select is(
  (select jsonb_array_length(r -> 'storageKeys') from deleted_skirting),
  2, 'Deleting a job returns its photo and thumbnail keys for storage cleanup');
select is(
  (select count(*) from public.completion_submission where task_id = (select task_id from deleted_skirting)),
  0::bigint, 'Deleting a job removes its submissions');
select is(
  (select count(*) from public.completion_photo where storage_key = 'photos/lc-skirting.jpg'),
  0::bigint, 'Deleting a job removes its photos');
select is(
  (select count(*) from public.task where id = (select task_id from deleted_skirting)),
  0::bigint, 'The job itself is gone');
select is(
  (select count(*) from public.audit_event
   where action = 'task.deleted' and entity_id = (select task_id from deleted_skirting)::text),
  1::bigint, 'The deletion is recorded in the audit log');
select is(pg_temp.notices('c2', 'Job removed'), 1::bigint, 'The crew is told when live work is removed');

select lives_ok(
  format('select public.delete_task(%s)', pg_temp.task('Replace door')),
  'A completed job can be deleted');
select is(
  (select count(*) from public.trade_section ts
   join public.trade_category tc on tc.id = ts.trade_category_id
   where ts.work_order_id = pg_temp.order_id('LC-1') and tc.name = 'Carpentry'),
  0::bigint, 'A trade heading with no jobs left is removed');

select lives_ok(format('select public.delete_task(%s)', pg_temp.task('Paint ceiling')), 'Another job can be deleted');
select throws_ok(
  format('select public.delete_task(%s)', pg_temp.task('Paint walls')),
  'P0001', 'A work order needs at least one job. Delete the whole work order instead.',
  'The last job cannot be deleted on its own');

-- ---------------------------------------------------------------------------
-- Editing a saved order
-- ---------------------------------------------------------------------------

create temp table before_edit as
select site_id, client_id from public.work_order where id = pg_temp.order_id('LC-1');
select is(
  public.update_work_order_details(pg_temp.order_id('LC-1'), $$
    {"clientName":"Lifecycle Client Pty Ltd","streetAddress":"1 Test St","suburb":"Saratoga",
     "state":"NSW","postcode":"2251","workOrderNumber":"LC-1","siteContactName":"New Contact",
     "siteContactPhone":"0411111111","dueDate":"2026-12-01","totalCents":175000}
  $$::jsonb) ->> 'notifiedWorkers',
  '2', 'Editing worker-visible details notifies the open crew');
select is(
  (select s.suburb || '/' || (s.id = (select site_id from before_edit))::text
   from public.work_order wo join public.site s on s.id = wo.site_id where wo.id = pg_temp.order_id('LC-1')),
  'Saratoga/true', 'A suburb typo is corrected on the same site');
select is(
  (select c.name || '/' || (c.id = (select client_id from before_edit))::text
   from public.work_order wo join public.client c on c.id = wo.client_id where wo.id = pg_temp.order_id('LC-1')),
  'Lifecycle Client Pty Ltd/true', 'A client used only by this order is renamed in place');
select is(
  (select total_cents from public.work_order_totals where work_order_id = pg_temp.order_id('LC-1')),
  175000::bigint, 'The total can be changed after saving');
select is(
  (select string_agg(name, ',') from public.site_contact where site_id = (select site_id from before_edit)),
  'New Contact', 'Saving replaces the site contact');
select is(
  public.update_work_order_details(pg_temp.order_id('LC-1'), $$
    {"clientName":"Lifecycle Client Pty Ltd","streetAddress":"1 Test St","suburb":"Saratoga",
     "state":"NSW","postcode":"2251","workOrderNumber":"LC-1","siteContactName":"New Contact",
     "siteContactPhone":"0411111111","dueDate":"2026-12-01","totalCents":175000,
     "notes":"Manager only"}
  $$::jsonb)::text,
  '{"changed": true, "notifiedWorkers": 0}', 'Manager-only edits change the order without messaging workers');
select is(
  public.update_work_order_details(pg_temp.order_id('LC-1'), $$
    {"clientName":"Lifecycle Client Pty Ltd","streetAddress":"1 Test St","suburb":"Saratoga",
     "state":"NSW","postcode":"2251","workOrderNumber":"LC-1","siteContactName":"New Contact",
     "siteContactPhone":"0411111111","dueDate":"2026-12-01","totalCents":175000,
     "notes":"Manager only"}
  $$::jsonb) ->> 'changed',
  'false', 'Saving without changes is reported as no change');

select public.create_work_order_bundle($$
  {"clientName":"Lifecycle Client Pty Ltd","streetAddress":"9 Other Rd","suburb":"Gosford",
   "state":"NSW","postcode":"2250","workOrderNumber":"LC-2","subtotalCents":0,"gstRate":0,
   "gstCents":0,"totalCents":0,"totalOverride":true,
   "tasks":[{"trade":"Painting","area":"","description":"Paint fence","quantity":10,"unit":"lm"}]}
$$::jsonb);
select throws_ok(
  format($f$select public.update_work_order_details(%s, '{"clientName":"Lifecycle Client Pty Ltd","streetAddress":"1 Test St","suburb":"Saratoga","state":"NSW","postcode":"2251","workOrderNumber":"LC-2","totalCents":1}'::jsonb)$f$,
    pg_temp.order_id('LC-1')),
  'P0001', 'A work order with that number already exists. Add a duplicate reason if this is intentional.',
  'Renaming onto another order''s number is refused');

-- ---------------------------------------------------------------------------
-- Clearing a crew
-- ---------------------------------------------------------------------------

select public.assign_work_order_crew(pg_temp.order_id('LC-2'), array[pg_temp.worker('c3')], null, array[public.business_today() + 3]);
select public.assign_work_order_crew(pg_temp.order_id('LC-2'), '{}'::bigint[], null, null);
select is(
  (select status::text || '/' || coalesce(lead_worker_id::text, 'none') from public.work_order where id = pg_temp.order_id('LC-2')),
  'ready/none', 'An empty crew unassigns the whole order');
select is(
  (select count(*) from public.schedule_entry where work_order_id = pg_temp.order_id('LC-2')),
  0::bigint, 'An unassigned order has no days ahead');

-- ---------------------------------------------------------------------------
-- Authorisation
-- ---------------------------------------------------------------------------

select pg_temp.act_as('d1');
select throws_ok(
  format($f$select public.delete_work_order(%s, 'LC-1')$f$, pg_temp.order_id('LC-1')),
  'P0001', 'Work order not found', 'Another tenant''s manager cannot delete the order');
select pg_temp.act_as('c2');
select throws_ok(
  format('select public.complete_work_order_tasks(%s, null)', pg_temp.order_id('LC-1')),
  'P0001', 'Forbidden', 'Workers cannot complete orders through the manager path');
select pg_temp.act_as('c1');
select ok(
  not has_function_privilege('anon', 'public.delete_work_order(bigint, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.notify_workers(uuid, bigint[], text, text, text, text, text)', 'execute'),
  'Deletion is not public and the notification helper is internal');

-- ---------------------------------------------------------------------------
-- Deleting a whole order
-- ---------------------------------------------------------------------------

insert into public.attachment (tenant_id, owner_type, owner_id, storage_key, content_type, size_bytes, uploaded_by)
values ('00000000-0000-0000-0000-0000000000c0', 'work_order', pg_temp.order_id('LC-1'),
  'originals/lc-1.pdf', 'application/pdf', 5000, '00000000-0000-0000-0000-0000000000c1');
insert into public.pdf_import (tenant_id, source, original_attachment_id, created_by)
select tenant_id, 'upload', id, uploaded_by from public.attachment where storage_key = 'originals/lc-1.pdf';

select throws_ok(
  format($f$select public.delete_work_order(%s, 'LC-2')$f$, pg_temp.order_id('LC-1')),
  'P0001', 'Type the work order number exactly to confirm the deletion.',
  'The wrong confirmation is refused');
create temp table deleted_order as
select pg_temp.order_id('LC-1') as order_id, public.delete_work_order(pg_temp.order_id('LC-1'), ' lc-1 ') as r;
select ok(
  (select r -> 'storageKeys' ? 'originals/lc-1.pdf' from deleted_order),
  'Deleting an order returns its original PDF key for storage cleanup');
select is(
  (select count(*) from public.work_order where id = (select order_id from deleted_order))
  + (select count(*) from public.task where work_order_id = (select order_id from deleted_order))
  + (select count(*) from public.attachment where storage_key = 'originals/lc-1.pdf'),
  0::bigint, 'The order, its jobs and its files are gone');
select is(
  (select count(*) from public.audit_event
   where action = 'work_order.deleted' and entity_id = (select order_id from deleted_order)::text),
  1::bigint, 'The order deletion is recorded in the audit log');

select * from finish();
rollback;
