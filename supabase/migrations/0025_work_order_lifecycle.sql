-- Work orders can be edited, trimmed, completed, archived and deleted after they
-- are saved, and a whole order can be handed to a crew of several workers.
--
-- 1. work_order.completed_at records when an order reached signed_off, so the
--    Completed list can show and sort by it.
-- 2. notify_workers is the one place the per-worker in-app/email/SMS fan-out
--    lives for the functions below.
-- 3. delete_task permanently removes one job from a saved order.
-- 4. add_work_order_task adds a job to a saved order and hands it to the order's
--    current crew.
-- 5. update_work_order_details edits the header and total of a saved order.
-- 6. delete_work_order permanently removes an order and everything under it.
-- 7. complete_work_order_tasks lets a manager mark one job, or the whole order,
--    complete.
-- 8. reopen_work_order moves a completed order back to active work.
-- 9. assign_work_order_crew assigns every open job to one or more workers at
--    once, with optional whole-order work days.
--
-- The deletes are hard deletes, by the owner's decision: a deleted job or order
-- takes its schedule, assignments, notes, completion submissions and photos with
-- it. Each delete writes a summary audit event, and the row-level audit triggers
-- still record every removed row, so the history of what existed survives in
-- audit_event. The functions return the R2 storage keys of removed files so the
-- server action can delete the objects once the transaction has committed.

-- ---------------------------------------------------------------------------
-- 1. Completion timestamp
-- ---------------------------------------------------------------------------

alter table public.work_order add column if not exists completed_at timestamptz;

create or replace function public.track_work_order_completion()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status in ('signed_off', 'completed') then
    if old.status not in ('signed_off', 'completed') then
      new.completed_at := now();
    end if;
  else
    new.completed_at := null;
  end if;
  return new;
end $$;

drop trigger if exists work_order_track_completion on public.work_order;
create trigger work_order_track_completion
  before update of status on public.work_order
  for each row execute function public.track_work_order_completion();

-- Orders that were already signed off take the time they got there, falling back
-- to their last update.
update public.work_order wo
set completed_at = coalesce(
  (
    select max(h.created_at)
    from public.work_order_status_history h
    where h.work_order_id = wo.id and h.to_status in ('signed_off', 'completed')
  ),
  wo.updated_at
)
where wo.status in ('signed_off', 'completed') and wo.completed_at is null;

create index if not exists work_order_tenant_completed_idx
  on public.work_order (tenant_id, completed_at desc)
  where completed_at is not null;

-- ---------------------------------------------------------------------------
-- 2. Shared worker notification fan-out
-- ---------------------------------------------------------------------------

-- Internal helper. One in-app and one email notice per distinct worker, plus an
-- SMS when both the worker and the tenant allow it and an SMS body is given.
-- Returns how many workers were notified. Bodies must never contain amounts.
create or replace function public.notify_workers(
  p_tenant_id uuid,
  p_worker_ids bigint[],
  p_subject text,
  p_in_app_body text,
  p_email_body text,
  p_sms_body text,
  p_action_url text
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  recipient record;
  notified integer := 0;
begin
  for recipient in
    select distinct w.user_id, (w.sms_opt_in and tn.sms_enabled) as sms_allowed
    from public.worker w
    join public.tenant tn on tn.id = w.tenant_id
    where w.tenant_id = p_tenant_id and w.id = any(coalesce(p_worker_ids, '{}'::bigint[]))
  loop
    perform public.queue_notification(
      recipient.user_id, 'in_app', p_subject, p_in_app_body, p_action_url
    );
    if p_email_body is not null then
      perform public.queue_notification(
        recipient.user_id, 'email', p_subject, p_email_body, p_action_url
      );
    end if;
    if p_sms_body is not null and recipient.sms_allowed then
      perform public.queue_notification(
        recipient.user_id, 'sms', p_subject, p_sms_body, p_action_url
      );
    end if;
    notified := notified + 1;
  end loop;
  return notified;
end $$;

revoke all on function public.notify_workers(uuid, bigint[], text, text, text, text, text) from public;

-- ---------------------------------------------------------------------------
-- 3. Delete one job from a saved work order
-- ---------------------------------------------------------------------------

create or replace function public.delete_task(p_task_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  tenant_key uuid := public.current_tenant_id();
  task_row record;
  remaining_total integer := 0;
  remaining_active integer := 0;
  affected_worker_ids bigint[] := '{}'::bigint[];
  submission_ids bigint[] := '{}'::bigint[];
  file_ids bigint[] := '{}'::bigint[];
  storage_keys text[] := '{}'::text[];
  removed_entries integer := 0;
  notification_count integer := 0;
begin
  if not public.is_manager() then raise exception 'Forbidden'; end if;

  select
    t.id, t.work_order_id, t.trade_section_id, t.description, t.quantity, t.unit,
    t.area_label, t.status, wo.work_order_number, wo.status as order_status
  into task_row
  from public.task t
  join public.work_order wo on wo.id = t.work_order_id and wo.tenant_id = tenant_key
  where t.id = p_task_id and t.tenant_id = tenant_key
  for update of t, wo;
  if not found then raise exception 'Job not found'; end if;

  -- An order with no jobs left would roll up to cancelled without anyone having
  -- cancelled it. Deleting the whole order is the honest way to get there.
  select count(*), count(*) filter (where status <> 'cancelled')
  into remaining_total, remaining_active
  from public.task
  where work_order_id = task_row.work_order_id and tenant_id = tenant_key and id <> p_task_id;
  if remaining_total = 0 or (task_row.order_status <> 'cancelled' and remaining_active = 0) then
    raise exception 'A work order needs at least one job. Delete the whole work order instead.';
  end if;

  select coalesce(array_agg(distinct a.worker_id), '{}'::bigint[])
  into affected_worker_ids
  from public.assignment a
  where a.task_id = p_task_id and a.tenant_id = tenant_key and a.status <> 'reassigned';

  select coalesce(array_agg(cs.id), '{}'::bigint[])
  into submission_ids
  from public.completion_submission cs
  where cs.task_id = p_task_id and cs.tenant_id = tenant_key;

  select coalesce(array_agg(a.id), '{}'::bigint[])
  into file_ids
  from public.attachment a
  where a.tenant_id = tenant_key
    and a.owner_type = 'completion_submission'
    and a.owner_id = any(submission_ids);

  select coalesce(array_agg(files.storage_key), '{}'::text[])
  into storage_keys
  from (
    select cp.storage_key from public.completion_photo cp
    where cp.completion_submission_id = any(submission_ids)
    union all
    select cp.thumbnail_key from public.completion_photo cp
    where cp.completion_submission_id = any(submission_ids) and cp.thumbnail_key is not null
    union all
    select a.storage_key from public.attachment a where a.id = any(file_ids)
  ) files;

  -- Only live work is worth a message. A finished or cancelled job leaving the
  -- list changes nothing a worker has to do.
  if task_row.status not in ('completed', 'cancelled') then
    notification_count := public.notify_workers(
      tenant_key, affected_worker_ids, 'Job removed',
      'A job on order ' || task_row.work_order_number || ' was removed from your work.',
      'A job on order ' || task_row.work_order_number
        || ' was removed from your work. Sign in to view your current work.',
      'A job on order ' || task_row.work_order_number
        || ' was removed. Open the app for your current work.',
      '/worker/jobs/' || task_row.work_order_id
    );
  end if;

  delete from public.pdf_import where original_attachment_id = any(file_ids);
  delete from public.attachment where id = any(file_ids);
  -- completion_photo rows go with their submission (on delete cascade).
  delete from public.completion_submission where id = any(submission_ids);
  delete from public.note
  where tenant_id = tenant_key and parent_type = 'task' and parent_id = p_task_id;
  delete from public.schedule_entry where task_id = p_task_id and tenant_id = tenant_key;
  get diagnostics removed_entries = row_count;
  delete from public.assignment where task_id = p_task_id and tenant_id = tenant_key;
  delete from public.task_status_history where task_id = p_task_id and tenant_id = tenant_key;
  -- task_pricing goes with the task (on delete cascade).
  delete from public.task where id = p_task_id and tenant_id = tenant_key;

  -- Drop the trade heading too once nothing is left under it.
  delete from public.trade_section ts
  where ts.id = task_row.trade_section_id
    and not exists (select 1 from public.task t where t.trade_section_id = ts.id);

  update public.work_order wo
  set lead_worker_id = null
  where wo.id = task_row.work_order_id
    and wo.lead_worker_id is not null
    and not exists (
      select 1
      from public.task t
      join public.assignment a
        on a.task_id = t.id and a.worker_id = wo.lead_worker_id and a.status <> 'reassigned'
      where t.work_order_id = wo.id
    );

  -- Deleting a row does not fire the status roll-up, and the job removed may
  -- have been the last one holding the order open.
  perform public.recompute_work_order_status(task_row.work_order_id);

  insert into public.audit_event (
    tenant_id, actor_user_id, actor_role, action, entity_type, entity_id,
    before, after, affected_worker_ids, notified
  ) values (
    tenant_key, auth.uid(), 'manager', 'task.deleted', 'task', p_task_id::text,
    jsonb_build_object(
      'workOrderId', task_row.work_order_id,
      'description', task_row.description,
      'quantity', task_row.quantity,
      'unit', task_row.unit,
      'areaLabel', task_row.area_label,
      'status', task_row.status,
      'workerIds', affected_worker_ids,
      'removedScheduleEntries', removed_entries,
      'removedSubmissions', cardinality(submission_ids),
      'removedFiles', cardinality(storage_keys)
    ),
    null,
    affected_worker_ids, notification_count > 0
  );

  return jsonb_build_object(
    'workOrderId', task_row.work_order_id,
    'notifiedWorkers', notification_count,
    'storageKeys', to_jsonb(storage_keys)
  );
end $$;

revoke all on function public.delete_task(bigint) from public;
grant execute on function public.delete_task(bigint) to authenticated;

comment on function public.delete_task(bigint) is
  'Manager-only permanent removal of one job, its schedule, assignments, notes, submissions and photos. Refuses to remove the last job on an order. Returns R2 keys to delete.';

-- ---------------------------------------------------------------------------
-- 4. Add a job to a saved work order
-- ---------------------------------------------------------------------------

create or replace function public.add_work_order_task(
  p_work_order_id bigint,
  p_trade text,
  p_description text,
  p_quantity numeric,
  p_unit text,
  p_area_label text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  tenant_key uuid := public.current_tenant_id();
  actor_key uuid := auth.uid();
  order_row record;
  trade_name text := trim(coalesce(p_trade, ''));
  area_value text := nullif(trim(coalesce(p_area_label, '')), '');
  trade_key bigint;
  section_key bigint;
  task_key bigint;
  next_sort integer;
  crew bigint[] := '{}'::bigint[];
  has_order_schedule boolean := false;
  initial_status public.task_status;
begin
  if not public.is_manager() then raise exception 'Forbidden'; end if;
  if length(trade_name) not between 1 and 100 then raise exception 'Choose a trade'; end if;
  if p_description is null or length(trim(p_description)) not between 2 and 1000 then
    raise exception 'Description must be between 2 and 1000 characters';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 999999 then
    raise exception 'Quantity must be greater than zero and no more than 999999';
  end if;
  if p_unit is null or p_unit not in ('ea','m2','lm','m3','hr') then
    raise exception 'Invalid task unit';
  end if;
  if length(coalesce(area_value, '')) > 120 then
    raise exception 'Area must be no more than 120 characters';
  end if;

  select wo.id, wo.status, wo.lead_worker_id
  into order_row
  from public.work_order wo
  where wo.id = p_work_order_id and wo.tenant_id = tenant_key
  for update;
  if not found then raise exception 'Work order not found'; end if;
  if order_row.status = 'cancelled' then
    raise exception 'Cancelled work orders cannot be changed';
  end if;

  select id into trade_key from public.trade_category
  where tenant_id = tenant_key and lower(name) = lower(trade_name) limit 1;
  if trade_key is null then
    insert into public.trade_category (tenant_id, name, sort_order)
    values (tenant_key, trade_name, 900) returning id into trade_key;
  end if;

  select coalesce(max(sort_order), 0) + 1 into next_sort
  from public.task where work_order_id = p_work_order_id;

  select id into section_key from public.trade_section
  where work_order_id = p_work_order_id
    and trade_category_id = trade_key
    and area_label is not distinct from area_value
  limit 1;
  if section_key is null then
    insert into public.trade_section (tenant_id, work_order_id, trade_category_id, area_label, sort_order)
    values (tenant_key, p_work_order_id, trade_key, area_value, next_sort)
    returning id into section_key;
  end if;

  -- The order is assigned as a whole, so a new job joins whoever is already on
  -- it. Only workers who can still sign in are carried over.
  select coalesce(array_agg(distinct a.worker_id), '{}'::bigint[])
  into crew
  from public.assignment a
  join public.task t on t.id = a.task_id
  join public.worker w on w.id = a.worker_id
  join public.user_profile up on up.id = w.user_id and up.is_active
  where t.work_order_id = p_work_order_id
    and t.status <> 'cancelled'
    and a.status <> 'reassigned';

  select exists (
    select 1 from public.schedule_entry
    where work_order_id = p_work_order_id and planned_date >= public.business_today()
  ) into has_order_schedule;

  initial_status := case
    when cardinality(crew) = 0 then 'ready'::public.task_status
    when has_order_schedule then 'scheduled'::public.task_status
    else 'assigned'::public.task_status
  end;

  insert into public.task (
    tenant_id, work_order_id, trade_section_id, description, quantity, unit,
    area_label, sort_order, status
  ) values (
    tenant_key, p_work_order_id, section_key, trim(p_description), p_quantity, p_unit,
    area_value, next_sort, initial_status
  ) returning id into task_key;

  if cardinality(crew) > 0 then
    insert into public.assignment (tenant_id, task_id, worker_id, is_lead, assigned_by)
    select tenant_key, task_key, member.id,
      coalesce(member.id = order_row.lead_worker_id, false), actor_key
    from unnest(crew) as member(id);
  end if;

  -- The roll-up trigger only watches updates, and a new open job reopens an
  -- order that had been completed.
  perform public.recompute_work_order_status(p_work_order_id);

  return jsonb_build_object(
    'taskId', task_key,
    'workOrderId', p_work_order_id,
    'assignedWorkers', cardinality(crew)
  );
end $$;

revoke all on function public.add_work_order_task(bigint, text, text, numeric, text, text) from public;
grant execute on function public.add_work_order_task(bigint, text, text, numeric, text, text) to authenticated;

comment on function public.add_work_order_task(bigint, text, text, numeric, text, text) is
  'Manager-only. Adds a job to a saved order and assigns it to the order''s current crew.';

-- ---------------------------------------------------------------------------
-- 5. Edit a saved work order's header and total
-- ---------------------------------------------------------------------------

create or replace function public.update_work_order_details(p_work_order_id bigint, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  tenant_key uuid := public.current_tenant_id();
  actor_key uuid := auth.uid();
  order_row record;
  client_name text := trim(coalesce(p_payload ->> 'clientName', ''));
  customer_name text := nullif(trim(coalesce(p_payload ->> 'customerName', '')), '');
  customer_phone text := nullif(trim(coalesce(p_payload ->> 'customerPhone', '')), '');
  street_value text := trim(coalesce(p_payload ->> 'streetAddress', ''));
  suburb_value text := trim(coalesce(p_payload ->> 'suburb', ''));
  state_value text := upper(trim(coalesce(p_payload ->> 'state', '')));
  postcode_value text := trim(coalesce(p_payload ->> 'postcode', ''));
  contact_name text := nullif(trim(coalesce(p_payload ->> 'siteContactName', '')), '');
  contact_phone text := nullif(trim(coalesce(p_payload ->> 'siteContactPhone', '')), '');
  order_number text := trim(coalesce(p_payload ->> 'workOrderNumber', ''));
  reference_value text := nullif(trim(coalesce(p_payload ->> 'clientReference', '')), '');
  duplicate_value text := nullif(trim(coalesce(p_payload ->> 'duplicateReason', '')), '');
  total_value bigint;
  client_key bigint;
  customer_key bigint;
  site_key bigint;
  before_snapshot jsonb;
  after_snapshot jsonb;
  before_visible jsonb;
  after_visible jsonb;
  crew bigint[] := '{}'::bigint[];
  notification_count integer := 0;
begin
  if not public.is_manager() then raise exception 'Forbidden'; end if;
  if length(client_name) not between 2 and 200 then
    raise exception 'Client name must be between 2 and 200 characters';
  end if;
  if length(street_value) not between 3 and 300 then raise exception 'Enter the site address'; end if;
  if length(suburb_value) not between 2 and 100 then raise exception 'Enter the suburb'; end if;
  if state_value not in ('NSW','ACT','VIC','QLD','SA','WA','TAS','NT') then
    raise exception 'Choose an Australian state or territory';
  end if;
  if postcode_value !~ '^\d{4}$' then raise exception 'Enter a four-digit postcode'; end if;
  if length(order_number) not between 1 and 100 then raise exception 'Enter the work order number'; end if;
  begin
    total_value := (p_payload ->> 'totalCents')::bigint;
  exception when others then
    raise exception 'Enter the work order total';
  end;
  if total_value is null or total_value < 0 then raise exception 'Enter the work order total'; end if;

  select wo.id, wo.client_id, wo.customer_id, wo.site_id, wo.status, wo.work_order_number
  into order_row
  from public.work_order wo
  where wo.id = p_work_order_id and wo.tenant_id = tenant_key
  for update;
  if not found then raise exception 'Work order not found'; end if;

  -- Checked here rather than left to the unique indexes, whose errors would
  -- reach the manager as a generic failure.
  if duplicate_value is null and exists (
    select 1 from public.work_order
    where tenant_id = tenant_key and id <> p_work_order_id
      and work_order_number = order_number and duplicate_reason is null
  ) then
    raise exception 'A work order with that number already exists. Add a duplicate reason if this is intentional.';
  end if;
  if duplicate_value is null and reference_value is not null and exists (
    select 1 from public.work_order
    where tenant_id = tenant_key and id <> p_work_order_id
      and client_reference = reference_value and duplicate_reason is null
  ) then
    raise exception 'A work order with that client reference already exists. Add a duplicate reason if this is intentional.';
  end if;

  select jsonb_build_object(
      'order', to_jsonb(wo) - 'updated_at',
      'client', c.name,
      'customer', jsonb_build_object('name', cu.name, 'phone', cu.phone),
      'site', jsonb_build_object(
        'street', s.street_address, 'suburb', s.suburb, 'state', s.state, 'postcode', s.postcode
      ),
      'contacts', (
        select coalesce(jsonb_agg(jsonb_build_array(sc.name, sc.phone) order by sc.id), '[]'::jsonb)
        from public.site_contact sc where sc.site_id = s.id
      ),
      'totalCents', tot.total_cents
    )
  into before_snapshot
  from public.work_order wo
  join public.client c on c.id = wo.client_id
  join public.site s on s.id = wo.site_id
  left join public.customer cu on cu.id = wo.customer_id
  left join public.work_order_totals tot on tot.work_order_id = wo.id
  where wo.id = p_work_order_id;

  -- Client: reuse a matching client; otherwise correct this order's client in
  -- place when nothing else uses it, so fixing a typo does not strand a record.
  select id into client_key from public.client
  where tenant_id = tenant_key and lower(name) = lower(client_name) limit 1;
  if client_key is not null then
    -- Same client, so a capitalisation fix is a correction worth keeping.
    update public.client set name = client_name where id = client_key and name <> client_name;
  else
    if not exists (
      select 1 from public.work_order
      where client_id = order_row.client_id and id <> p_work_order_id
    ) and not exists (select 1 from public.pdf_import where client_id = order_row.client_id) then
      update public.client set name = client_name where id = order_row.client_id;
      client_key := order_row.client_id;
    else
      insert into public.client (tenant_id, name) values (tenant_key, client_name)
      returning id into client_key;
    end if;
  end if;

  -- Customer: optional, matched on name and phone like create_work_order_bundle.
  if customer_name is not null then
    select id into customer_key from public.customer
    where tenant_id = tenant_key and lower(name) = lower(customer_name)
      and coalesce(phone, '') = coalesce(customer_phone, '')
    limit 1;
    if customer_key is null then
      if order_row.customer_id is not null and not exists (
        select 1 from public.work_order
        where customer_id = order_row.customer_id and id <> p_work_order_id
      ) then
        update public.customer set name = customer_name, phone = customer_phone
        where id = order_row.customer_id;
        customer_key := order_row.customer_id;
      else
        insert into public.customer (tenant_id, name, phone)
        values (tenant_key, customer_name, customer_phone)
        returning id into customer_key;
      end if;
    end if;
  end if;

  -- Site: the same street and postcode is the same place, so a matching site is
  -- reused and takes the corrected suburb and state. A new address corrects this
  -- order's site in place when nothing else uses it.
  select id into site_key from public.site
  where tenant_id = tenant_key
    and lower(street_address) = lower(street_value)
    and postcode = postcode_value
  limit 1;
  if site_key is not null then
    update public.site
    set street_address = street_value, suburb = suburb_value, state = state_value
    where id = site_key
      and (street_address, suburb, state) is distinct from (street_value, suburb_value, state_value);
  elsif not exists (
    select 1 from public.work_order where site_id = order_row.site_id and id <> p_work_order_id
  ) then
    update public.site
    set street_address = street_value, suburb = suburb_value, state = state_value,
      postcode = postcode_value, latitude = null, longitude = null
    where id = order_row.site_id;
    site_key := order_row.site_id;
  else
    insert into public.site (tenant_id, street_address, suburb, state, postcode)
    values (tenant_key, street_value, suburb_value, state_value, postcode_value)
    returning id into site_key;
  end if;

  -- The detail page shows one site contact. Saving replaces the site's contact
  -- list with the one entered, or clears it when the field is left empty.
  if (
    select coalesce(jsonb_agg(jsonb_build_array(sc.name, sc.phone) order by sc.id), '[]'::jsonb)
    from public.site_contact sc where sc.site_id = site_key
  ) is distinct from (
    case when contact_name is null then '[]'::jsonb
    else jsonb_build_array(jsonb_build_array(contact_name, contact_phone)) end
  ) then
    delete from public.site_contact where site_id = site_key;
    if contact_name is not null then
      insert into public.site_contact (tenant_id, site_id, name, phone, relationship)
      values (tenant_key, site_key, contact_name, contact_phone, 'site contact');
    end if;
  end if;

  update public.work_order
  set client_id = client_key,
    customer_id = customer_key,
    site_id = site_key,
    work_order_number = order_number,
    job_number = nullif(trim(coalesce(p_payload ->> 'jobNumber', '')), ''),
    client_reference = reference_value,
    client_supervisor_name = nullif(trim(coalesce(p_payload ->> 'supervisorName', '')), ''),
    client_supervisor_phone = nullif(trim(coalesce(p_payload ->> 'supervisorPhone', '')), ''),
    issued_at = nullif(p_payload ->> 'issuedAt', '')::timestamptz,
    start_date = nullif(p_payload ->> 'startDate', '')::date,
    completion_due_date = nullif(p_payload ->> 'dueDate', '')::date,
    notes = nullif(trim(coalesce(p_payload ->> 'notes', '')), ''),
    additional_instructions = nullif(trim(coalesce(p_payload ->> 'additionalInstructions', '')), ''),
    duplicate_reason = duplicate_value
  where id = p_work_order_id and tenant_id = tenant_key;

  insert into public.work_order_totals (
    work_order_id, tenant_id, subtotal_cents, gst_rate, gst_cents, total_cents, total_override, updated_by
  ) values (p_work_order_id, tenant_key, total_value, 0, 0, total_value, true, actor_key)
  on conflict (work_order_id) do update
  set subtotal_cents = excluded.subtotal_cents,
    gst_rate = excluded.gst_rate,
    gst_cents = excluded.gst_cents,
    total_cents = excluded.total_cents,
    total_override = true,
    updated_by = excluded.updated_by
  where public.work_order_totals.total_cents is distinct from excluded.total_cents;

  select jsonb_build_object(
      'order', to_jsonb(wo) - 'updated_at',
      'client', c.name,
      'customer', jsonb_build_object('name', cu.name, 'phone', cu.phone),
      'site', jsonb_build_object(
        'street', s.street_address, 'suburb', s.suburb, 'state', s.state, 'postcode', s.postcode
      ),
      'contacts', (
        select coalesce(jsonb_agg(jsonb_build_array(sc.name, sc.phone) order by sc.id), '[]'::jsonb)
        from public.site_contact sc where sc.site_id = s.id
      ),
      'totalCents', tot.total_cents
    )
  into after_snapshot
  from public.work_order wo
  join public.client c on c.id = wo.client_id
  join public.site s on s.id = wo.site_id
  left join public.customer cu on cu.id = wo.customer_id
  left join public.work_order_totals tot on tot.work_order_id = wo.id
  where wo.id = p_work_order_id;

  if before_snapshot = after_snapshot then
    return jsonb_build_object('changed', false, 'notifiedWorkers', 0);
  end if;

  -- Only what worker_job_safe exposes counts as a change a worker should hear
  -- about. Notes, supervisor details and the total are manager-only.
  before_visible := jsonb_build_object(
    'number', before_snapshot #> '{order,work_order_number}',
    'job', before_snapshot #> '{order,job_number}',
    'reference', before_snapshot #> '{order,client_reference}',
    'start', before_snapshot #> '{order,start_date}',
    'due', before_snapshot #> '{order,completion_due_date}',
    'instructions', before_snapshot #> '{order,additional_instructions}',
    'client', before_snapshot -> 'client',
    'site', before_snapshot -> 'site',
    'contacts', before_snapshot -> 'contacts'
  );
  after_visible := jsonb_build_object(
    'number', after_snapshot #> '{order,work_order_number}',
    'job', after_snapshot #> '{order,job_number}',
    'reference', after_snapshot #> '{order,client_reference}',
    'start', after_snapshot #> '{order,start_date}',
    'due', after_snapshot #> '{order,completion_due_date}',
    'instructions', after_snapshot #> '{order,additional_instructions}',
    'client', after_snapshot -> 'client',
    'site', after_snapshot -> 'site',
    'contacts', after_snapshot -> 'contacts'
  );

  select coalesce(array_agg(distinct a.worker_id), '{}'::bigint[])
  into crew
  from public.assignment a
  join public.task t on t.id = a.task_id
  where t.work_order_id = p_work_order_id
    and t.status not in ('completed', 'cancelled')
    and a.status <> 'reassigned';

  if before_visible is distinct from after_visible
    and order_row.status not in ('cancelled', 'signed_off', 'completed') then
    notification_count := public.notify_workers(
      tenant_key, crew, 'Work order updated',
      'Details on order ' || order_number || ' were updated. Check them before your next visit.',
      'Details on order ' || order_number
        || ' were updated. Sign in and check them before your next visit.',
      'Details on order ' || order_number || ' were updated. Open the app to check them.',
      '/worker/jobs/' || p_work_order_id
    );
  end if;

  insert into public.audit_event (
    tenant_id, actor_user_id, actor_role, action, entity_type, entity_id,
    before, after, affected_worker_ids, notified
  ) values (
    tenant_key, actor_key, 'manager', 'work_order.details_updated', 'work_order',
    p_work_order_id::text, before_snapshot, after_snapshot, crew, notification_count > 0
  );

  return jsonb_build_object('changed', true, 'notifiedWorkers', notification_count);
end $$;

revoke all on function public.update_work_order_details(bigint, jsonb) from public;
grant execute on function public.update_work_order_details(bigint, jsonb) to authenticated;

comment on function public.update_work_order_details(bigint, jsonb) is
  'Manager-only edit of a saved order''s client, site, references, dates, instructions and total. Notifies the open crew only when worker-visible details change.';

-- ---------------------------------------------------------------------------
-- 6. Delete a whole work order
-- ---------------------------------------------------------------------------

create or replace function public.delete_work_order(p_work_order_id bigint, p_confirmation text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  tenant_key uuid := public.current_tenant_id();
  order_row record;
  all_task_ids bigint[] := '{}'::bigint[];
  submission_ids bigint[] := '{}'::bigint[];
  file_ids bigint[] := '{}'::bigint[];
  storage_keys text[] := '{}'::text[];
  affected_worker_ids bigint[] := '{}'::bigint[];
  total_cents_value bigint;
  notification_count integer := 0;
begin
  if not public.is_manager() then raise exception 'Forbidden'; end if;

  select wo.id, wo.work_order_number, wo.status, c.name as client_name, s.suburb
  into order_row
  from public.work_order wo
  join public.client c on c.id = wo.client_id
  join public.site s on s.id = wo.site_id
  where wo.id = p_work_order_id and wo.tenant_id = tenant_key
  for update of wo;
  if not found then raise exception 'Work order not found'; end if;

  if lower(trim(coalesce(p_confirmation, ''))) <> lower(trim(order_row.work_order_number)) then
    raise exception 'Type the work order number exactly to confirm the deletion.';
  end if;

  select coalesce(array_agg(t.id order by t.id), '{}'::bigint[])
  into all_task_ids
  from public.task t
  where t.work_order_id = p_work_order_id and t.tenant_id = tenant_key;

  select coalesce(array_agg(cs.id), '{}'::bigint[])
  into submission_ids
  from public.completion_submission cs
  where cs.task_id = any(all_task_ids) and cs.tenant_id = tenant_key;

  select coalesce(array_agg(a.id), '{}'::bigint[])
  into file_ids
  from public.attachment a
  where a.tenant_id = tenant_key
    and (
      (a.owner_type = 'work_order' and a.owner_id = p_work_order_id)
      or (a.owner_type = 'completion_submission' and a.owner_id = any(submission_ids))
    );

  select coalesce(array_agg(files.storage_key), '{}'::text[])
  into storage_keys
  from (
    select cp.storage_key from public.completion_photo cp
    where cp.completion_submission_id = any(submission_ids)
    union all
    select cp.thumbnail_key from public.completion_photo cp
    where cp.completion_submission_id = any(submission_ids) and cp.thumbnail_key is not null
    union all
    select a.storage_key from public.attachment a where a.id = any(file_ids)
  ) files;

  select coalesce(array_agg(distinct a.worker_id), '{}'::bigint[])
  into affected_worker_ids
  from public.assignment a
  join public.task t on t.id = a.task_id
  where t.id = any(all_task_ids)
    and t.status not in ('completed', 'cancelled')
    and a.status <> 'reassigned';

  select total_cents into total_cents_value
  from public.work_order_totals where work_order_id = p_work_order_id;

  notification_count := public.notify_workers(
    tenant_key, affected_worker_ids, 'Work order removed',
    'Order ' || order_row.work_order_number || ' was removed from your work.',
    'Order ' || order_row.work_order_number
      || ' was removed from your work. Sign in to view your current work.',
    'Order ' || order_row.work_order_number
      || ' was removed. Open the app for your current work.',
    '/worker'
  );

  -- Children that restrict deletion go first; the rest cascade from work_order.
  delete from public.pdf_import where original_attachment_id = any(file_ids);
  delete from public.attachment where id = any(file_ids);
  delete from public.completion_submission where id = any(submission_ids);
  delete from public.note
  where tenant_id = tenant_key
    and (
      (parent_type = 'task' and parent_id = any(all_task_ids))
      or (parent_type = 'work_order' and parent_id = p_work_order_id)
    );
  delete from public.schedule_entry
  where tenant_id = tenant_key
    and (work_order_id = p_work_order_id or task_id = any(all_task_ids));
  delete from public.assignment where tenant_id = tenant_key and task_id = any(all_task_ids);
  delete from public.task_status_history
  where tenant_id = tenant_key and task_id = any(all_task_ids);
  delete from public.work_order_status_history
  where tenant_id = tenant_key and work_order_id = p_work_order_id;
  -- trade_section, task, task_pricing and work_order_totals cascade.
  delete from public.work_order where id = p_work_order_id and tenant_id = tenant_key;

  insert into public.audit_event (
    tenant_id, actor_user_id, actor_role, action, entity_type, entity_id,
    before, after, affected_worker_ids, notified
  ) values (
    tenant_key, auth.uid(), 'manager', 'work_order.deleted', 'work_order',
    p_work_order_id::text,
    jsonb_build_object(
      'workOrderNumber', order_row.work_order_number,
      'clientName', order_row.client_name,
      'suburb', order_row.suburb,
      'status', order_row.status,
      'taskCount', cardinality(all_task_ids),
      'totalCents', total_cents_value,
      'removedSubmissions', cardinality(submission_ids),
      'removedFiles', cardinality(storage_keys)
    ),
    null,
    affected_worker_ids, notification_count > 0
  );

  return jsonb_build_object(
    'deletedTasks', cardinality(all_task_ids),
    'notifiedWorkers', notification_count,
    'storageKeys', to_jsonb(storage_keys)
  );
end $$;

revoke all on function public.delete_work_order(bigint, text) from public;
grant execute on function public.delete_work_order(bigint, text) to authenticated;

comment on function public.delete_work_order(bigint, text) is
  'Manager-only permanent deletion of an order and everything under it. The caller must repeat the order number. Returns R2 keys to delete.';

-- ---------------------------------------------------------------------------
-- 7. Manager completion of one job or the whole order
-- ---------------------------------------------------------------------------

create or replace function public.complete_work_order_tasks(
  p_work_order_id bigint,
  p_task_ids bigint[] default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  tenant_key uuid := public.current_tenant_id();
  order_row record;
  target_ids bigint[] := '{}'::bigint[];
  crew bigint[] := '{}'::bigint[];
  approved_count integer := 0;
  removed_entries integer := 0;
  removed_order_entries integer := 0;
  next_status public.work_order_status;
  notification_count integer := 0;
begin
  if not public.is_manager() then raise exception 'Forbidden'; end if;

  select wo.id, wo.work_order_number, wo.status
  into order_row
  from public.work_order wo
  where wo.id = p_work_order_id and wo.tenant_id = tenant_key
  for update;
  if not found then raise exception 'Work order not found'; end if;
  if order_row.status = 'cancelled' then
    raise exception 'Cancelled work orders cannot be completed';
  end if;

  -- A null list means every open job on the order.
  select coalesce(array_agg(t.id order by t.sort_order, t.id), '{}'::bigint[])
  into target_ids
  from public.task t
  where t.work_order_id = p_work_order_id
    and t.tenant_id = tenant_key
    and t.status not in ('completed', 'cancelled')
    and (p_task_ids is null or t.id = any(p_task_ids));

  if cardinality(target_ids) = 0 then
    return jsonb_build_object(
      'completedTasks', 0,
      'workOrderStatus', order_row.status,
      'approvedSubmissions', 0
    );
  end if;

  select coalesce(array_agg(distinct a.worker_id), '{}'::bigint[])
  into crew
  from public.assignment a
  join public.task t on t.id = a.task_id
  where t.work_order_id = p_work_order_id and a.status <> 'reassigned';

  -- Anything a worker already sent in is accepted, so it does not linger in the
  -- Review queue for work that is now closed.
  update public.completion_submission
  set status = 'approved',
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    review_notes = coalesce(review_notes, 'Marked complete by a manager')
  where tenant_id = tenant_key and task_id = any(target_ids) and status = 'submitted';
  get diagnostics approved_count = row_count;

  -- One statement, so the statement-level roll-up recomputes the order once.
  update public.task
  set status = 'completed', completed_at = now()
  where tenant_id = tenant_key and id = any(target_ids);

  -- Finished work no longer needs future days on the calendar. Today and the
  -- past stay as the record of when it was done.
  delete from public.schedule_entry
  where tenant_id = tenant_key
    and task_id = any(target_ids)
    and planned_date > public.business_today();
  get diagnostics removed_entries = row_count;

  select status into next_status from public.work_order where id = p_work_order_id;

  if next_status = 'signed_off' then
    delete from public.schedule_entry
    where tenant_id = tenant_key
      and work_order_id = p_work_order_id
      and planned_date > public.business_today();
    get diagnostics removed_order_entries = row_count;
    removed_entries := removed_entries + removed_order_entries;

    if order_row.status <> 'signed_off' then
      -- In-app only: nothing is being asked of the worker.
      notification_count := public.notify_workers(
        tenant_key, crew, 'Work order completed',
        'Order ' || order_row.work_order_number || ' has been marked complete.',
        null, null, '/worker/history'
      );
    end if;
  end if;

  insert into public.audit_event (
    tenant_id, actor_user_id, actor_role, action, entity_type, entity_id,
    before, after, affected_worker_ids, notified
  ) values (
    tenant_key, auth.uid(), 'manager',
    case when p_task_ids is null then 'work_order.completed' else 'task.completed_by_manager' end,
    'work_order', p_work_order_id::text,
    jsonb_build_object('status', order_row.status, 'taskIds', target_ids),
    jsonb_build_object(
      'status', next_status,
      'completedTasks', cardinality(target_ids),
      'approvedSubmissions', approved_count,
      'removedScheduleEntries', removed_entries
    ),
    crew, notification_count > 0
  );

  return jsonb_build_object(
    'completedTasks', cardinality(target_ids),
    'workOrderStatus', next_status,
    'approvedSubmissions', approved_count
  );
end $$;

revoke all on function public.complete_work_order_tasks(bigint, bigint[]) from public;
grant execute on function public.complete_work_order_tasks(bigint, bigint[]) to authenticated;

comment on function public.complete_work_order_tasks(bigint, bigint[]) is
  'Manager-only completion of chosen jobs, or every open job when the list is null. Approves pending submissions and clears future dates for finished work.';

-- ---------------------------------------------------------------------------
-- 8. Reopen a completed work order
-- ---------------------------------------------------------------------------

create or replace function public.reopen_work_order(p_work_order_id bigint, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  tenant_key uuid := public.current_tenant_id();
  order_row record;
  reason_value text := nullif(trim(coalesce(p_reason, '')), '');
  target_ids bigint[] := '{}'::bigint[];
  crew bigint[] := '{}'::bigint[];
  next_status public.work_order_status;
  notification_count integer := 0;
begin
  if not public.is_manager() then raise exception 'Forbidden'; end if;
  if length(coalesce(reason_value, '')) > 500 then
    raise exception 'A reason must be 500 characters or fewer';
  end if;

  select wo.id, wo.work_order_number, wo.status
  into order_row
  from public.work_order wo
  where wo.id = p_work_order_id and wo.tenant_id = tenant_key
  for update;
  if not found then raise exception 'Work order not found'; end if;
  if order_row.status not in ('signed_off', 'completed') then
    raise exception 'Only completed work orders can be reopened';
  end if;

  select coalesce(array_agg(t.id), '{}'::bigint[])
  into target_ids
  from public.task t
  where t.work_order_id = p_work_order_id and t.tenant_id = tenant_key and t.status = 'completed';

  -- Each job goes back to where planning would put it: on the calendar if it
  -- still has a date ahead, with its crew if it has one, otherwise unassigned.
  update public.task t
  set status = case
      when exists (
        select 1 from public.schedule_entry se
        where se.planned_date >= public.business_today()
          and (se.task_id = t.id or se.work_order_id = t.work_order_id)
      ) and exists (
        select 1 from public.assignment a where a.task_id = t.id and a.status <> 'reassigned'
      ) then 'scheduled'::public.task_status
      when exists (
        select 1 from public.assignment a where a.task_id = t.id and a.status <> 'reassigned'
      ) then 'assigned'::public.task_status
      else 'ready'::public.task_status
    end,
    completed_at = null,
    revised_since_viewed = true
  where t.id = any(target_ids);

  select status into next_status from public.work_order where id = p_work_order_id;

  select coalesce(array_agg(distinct a.worker_id), '{}'::bigint[])
  into crew
  from public.assignment a
  where a.task_id = any(target_ids) and a.status <> 'reassigned';

  -- The reason is manager-written text, so like the other reopen paths it stays
  -- in the audit event rather than being sent out in a message body.
  notification_count := public.notify_workers(
    tenant_key, crew, 'Work order reopened',
    'Order ' || order_row.work_order_number || ' was reopened and is back in your work.',
    'Order ' || order_row.work_order_number
      || ' was reopened and is back in your work. Sign in for the details.',
    'Order ' || order_row.work_order_number || ' was reopened. Open the app for the details.',
    '/worker/jobs/' || p_work_order_id
  );

  insert into public.audit_event (
    tenant_id, actor_user_id, actor_role, action, entity_type, entity_id,
    before, after, affected_worker_ids, notified
  ) values (
    tenant_key, auth.uid(), 'manager', 'work_order.reopened', 'work_order',
    p_work_order_id::text,
    jsonb_build_object('status', order_row.status, 'taskIds', target_ids),
    jsonb_build_object('status', next_status, 'reason', reason_value),
    crew, notification_count > 0
  );

  return jsonb_build_object('reopenedTasks', cardinality(target_ids), 'workOrderStatus', next_status);
end $$;

revoke all on function public.reopen_work_order(bigint, text) from public;
grant execute on function public.reopen_work_order(bigint, text) to authenticated;

comment on function public.reopen_work_order(bigint, text) is
  'Manager-only. Returns a completed order''s jobs to planning and notifies the crew.';

-- ---------------------------------------------------------------------------
-- 9. Assign a whole work order to a crew
-- ---------------------------------------------------------------------------

create or replace function public.assign_work_order_crew(
  p_work_order_id bigint,
  p_worker_ids bigint[],
  p_lead_worker_id bigint default null,
  p_dates date[] default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  tenant_key uuid := public.current_tenant_id();
  actor_key uuid := auth.uid();
  today date := public.business_today();
  order_row record;
  crew bigint[] := '{}'::bigint[];
  lead_key bigint;
  selected_dates date[] := null;
  target_ids bigint[] := '{}'::bigint[];
  previous_crew bigint[] := '{}'::bigint[];
  removed_workers bigint[] := '{}'::bigint[];
  added_workers bigint[] := '{}'::bigint[];
  removed_entries integer := 0;
  cleared_entries integer := 0;
  scheduled_days integer := 0;
  has_order_schedule boolean := false;
begin
  if not public.is_manager() then raise exception 'Forbidden'; end if;

  select coalesce(array_agg(distinct member.id), '{}'::bigint[])
  into crew
  from unnest(coalesce(p_worker_ids, '{}'::bigint[])) as member(id)
  where member.id is not null;

  if cardinality(crew) > 50 then raise exception 'Choose no more than 50 workers'; end if;
  if exists (
    select 1 from unnest(crew) as member(id)
    where not exists (
      select 1 from public.worker w
      join public.user_profile up on up.id = w.user_id
      where w.id = member.id and w.tenant_id = tenant_key and up.is_active
    )
  ) then
    raise exception 'One or more of the chosen workers is unavailable';
  end if;

  if cardinality(crew) > 0 then
    lead_key := coalesce(p_lead_worker_id, crew[1]);
    if not (lead_key = any(crew)) then
      raise exception 'Choose the lead from the selected workers';
    end if;
  elsif p_lead_worker_id is not null then
    raise exception 'Choose the lead from the selected workers';
  end if;

  if p_dates is not null and cardinality(p_dates) > 0 then
    select array_agg(day order by day)
    into selected_dates
    from (select distinct unnest(p_dates) as day) dates
    where day is not null;
    if cardinality(selected_dates) > 62 then
      raise exception 'Choose between 1 and 62 schedule dates';
    end if;
    if cardinality(crew) = 0 then
      raise exception 'Choose at least one worker for those dates';
    end if;
  end if;

  select wo.id, wo.work_order_number, wo.status
  into order_row
  from public.work_order wo
  where wo.id = p_work_order_id and wo.tenant_id = tenant_key
  for update;
  if not found then raise exception 'Work order not found'; end if;
  if order_row.status = 'cancelled' then
    raise exception 'Cancelled work orders cannot be assigned';
  end if;
  if order_row.status in ('signed_off', 'completed') then
    raise exception 'Reopen the work order before changing its crew';
  end if;

  select coalesce(array_agg(t.id order by t.sort_order, t.id), '{}'::bigint[])
  into target_ids
  from public.task t
  where t.work_order_id = p_work_order_id
    and t.tenant_id = tenant_key
    and t.status not in ('completed', 'cancelled');
  if cardinality(target_ids) = 0 then
    raise exception 'This work order has no open jobs to assign';
  end if;

  select coalesce(array_agg(distinct a.worker_id), '{}'::bigint[])
  into previous_crew
  from public.assignment a
  where a.task_id = any(target_ids) and a.status <> 'reassigned';

  select coalesce(array_agg(member.id), '{}'::bigint[])
  into removed_workers
  from unnest(previous_crew) as member(id)
  where not (member.id = any(crew));

  select coalesce(array_agg(member.id), '{}'::bigint[])
  into added_workers
  from unnest(crew) as member(id)
  where not (member.id = any(previous_crew));

  -- Told while they can still be identified as being on the order.
  perform public.notify_workers(
    tenant_key, removed_workers, 'Work unassigned',
    'Work on order ' || order_row.work_order_number || ' is no longer assigned to you.',
    'Work on order ' || order_row.work_order_number
      || ' is no longer assigned to you. Sign in to view your current work.',
    'Work on order ' || order_row.work_order_number
      || ' was unassigned. Open the app for your current work.',
    '/worker'
  );

  update public.assignment
  set status = 'reassigned',
    is_lead = false,
    reassigned_at = now(),
    reassigned_reason = 'Removed from the work order crew'
  where tenant_id = tenant_key
    and task_id = any(target_ids)
    and status <> 'reassigned'
    and not (worker_id = any(crew));

  -- People who left the crew come off the days ahead. Past days stay, because
  -- they record who was actually on site.
  delete from public.schedule_entry
  where tenant_id = tenant_key
    and planned_date >= today
    and (work_order_id = p_work_order_id or task_id = any(target_ids))
    and (worker_id is null or not (worker_id = any(crew)));
  get diagnostics removed_entries = row_count;

  -- One lead per job: clear the old flags before setting the new one, so the
  -- partial unique index never sees two.
  update public.assignment
  set is_lead = false
  where task_id = any(target_ids) and status <> 'reassigned' and is_lead
    and worker_id is distinct from lead_key;
  update public.assignment
  set is_lead = true
  where task_id = any(target_ids) and status <> 'reassigned' and not is_lead
    and worker_id = lead_key;

  -- One insert, so the statement-level trigger sends each newly added worker a
  -- single "new work" message for the whole order.
  insert into public.assignment (tenant_id, task_id, worker_id, is_lead, assigned_by)
  select tenant_key, job.id, member.id, member.id = lead_key, actor_key
  from unnest(target_ids) as job(id)
  cross join unnest(crew) as member(id)
  where not exists (
    select 1 from public.assignment a
    where a.task_id = job.id and a.worker_id = member.id and a.status <> 'reassigned'
  );

  if selected_dates is not null then
    -- Picking days replaces the plan ahead for this order, including any
    -- per-job time slots booked by the older scheduling flow.
    delete from public.schedule_entry
    where tenant_id = tenant_key
      and planned_date >= today
      and (work_order_id = p_work_order_id or task_id = any(target_ids));
    get diagnostics cleared_entries = row_count;
    removed_entries := removed_entries + cleared_entries;

    insert into public.schedule_entry (
      tenant_id, work_order_id, worker_id, planned_date, multi_day_sequence, created_by
    )
    select tenant_key, p_work_order_id, member.id, day.value, day.seq, actor_key
    from unnest(crew) as member(id)
    cross join unnest(selected_dates) with ordinality as day(value, seq)
    on conflict (work_order_id, worker_id, planned_date) where work_order_id is not null
    do nothing;
    scheduled_days := cardinality(selected_dates);
  elsif cardinality(added_workers) > 0 then
    -- No new days picked: whoever joins works the days the order already has
    -- ahead, so the calendar shows the whole crew on them.
    insert into public.schedule_entry (
      tenant_id, work_order_id, worker_id, planned_date, multi_day_sequence, created_by
    )
    select tenant_key, p_work_order_id, member.id, planned.planned_date, planned.seq, actor_key
    from unnest(added_workers) as member(id)
    cross join (
      select days.planned_date, row_number() over (order by days.planned_date) as seq
      from (
        select distinct se.planned_date
        from public.schedule_entry se
        where se.work_order_id = p_work_order_id and se.planned_date >= today
      ) days
    ) planned
    on conflict (work_order_id, worker_id, planned_date) where work_order_id is not null
    do nothing;
  end if;

  select exists (
    select 1 from public.schedule_entry
    where work_order_id = p_work_order_id and planned_date >= today
  ) into has_order_schedule;

  -- Jobs still in planning follow the crew. Started work keeps its status.
  with planned as (
    select t.id,
      case
        when cardinality(crew) = 0 then 'ready'::public.task_status
        when has_order_schedule or exists (
          select 1 from public.schedule_entry se
          where se.task_id = t.id and se.planned_date >= today
        ) then 'scheduled'::public.task_status
        else 'assigned'::public.task_status
      end as next_status
    from public.task t
    where t.id = any(target_ids) and t.status in ('draft', 'ready', 'assigned', 'scheduled')
  )
  update public.task t
  set status = planned.next_status
  from planned
  where t.id = planned.id and t.status <> planned.next_status;

  update public.work_order
  set lead_worker_id = lead_key
  where id = p_work_order_id and lead_worker_id is distinct from lead_key;
  perform public.recompute_work_order_status(p_work_order_id);

  insert into public.audit_event (
    tenant_id, actor_user_id, actor_role, action, entity_type, entity_id,
    before, after, affected_worker_ids, notified
  ) values (
    tenant_key, actor_key, 'manager', 'work_order.crew_assigned', 'work_order',
    p_work_order_id::text,
    jsonb_build_object('workerIds', previous_crew),
    jsonb_build_object(
      'workerIds', crew,
      'leadWorkerId', lead_key,
      'dates', selected_dates,
      'removedScheduleEntries', removed_entries
    ),
    (select coalesce(array_agg(distinct member.id), '{}'::bigint[])
       from unnest(previous_crew || crew) as member(id)),
    cardinality(added_workers) + cardinality(removed_workers) > 0
  );

  return jsonb_build_object(
    'crewSize', cardinality(crew),
    'addedWorkers', cardinality(added_workers),
    'removedWorkers', cardinality(removed_workers),
    'assignedTasks', case when cardinality(crew) = 0 then 0 else cardinality(target_ids) end,
    'scheduledDays', scheduled_days
  );
end $$;

revoke all on function public.assign_work_order_crew(bigint, bigint[], bigint, date[]) from public;
grant execute on function public.assign_work_order_crew(bigint, bigint[], bigint, date[]) to authenticated;

comment on function public.assign_work_order_crew(bigint, bigint[], bigint, date[]) is
  'Manager-only. Makes the given workers the crew on every open job of an order, with one lead and optional whole-order work days. An empty crew unassigns the order.';
