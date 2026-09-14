begin;
select plan(7);
select set_config('request.jwt.claim.role', 'service_role', true);
insert into public.tenant (id, name) values ('00000000-0000-0000-0000-000000000090', 'Removal test');
insert into auth.users (id, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000091', 'remove-test@example.com', '{"tenant_id":"00000000-0000-0000-0000-000000000090","role":"worker","display_name":"Removal Test"}');
select throws_ok(
 $$update auth.users set deleted_at=now() where id='00000000-0000-0000-0000-000000000091'$$,
 'P0001', 'Disable the worker before removing their account', 'Active worker deletion is rejected');
update public.user_profile set is_active=false where id='00000000-0000-0000-0000-000000000091';
select throws_ok(
 $$update public.user_profile set deleted_at=now() where id='00000000-0000-0000-0000-000000000091'$$,
 'P0001', 'Remove the Auth account first', 'Profile alone cannot remove an account');
select lives_ok(
 $$update auth.users set deleted_at=now() where id='00000000-0000-0000-0000-000000000091'$$,
 'Disabled worker Auth removal succeeds');
select ok((select deleted_at is not null and not is_active from public.user_profile where id='00000000-0000-0000-0000-000000000091'), 'Removed profile remains inactive');
select is((select email from public.user_profile where id='00000000-0000-0000-0000-000000000091'), '00000000-0000-0000-0000-000000000091@removed.invalid', 'Email is released for a new invitation');
select ok(exists(select 1 from public.worker where user_id='00000000-0000-0000-0000-000000000091'), 'Historical worker identity remains');
select throws_ok(
 $$update public.user_profile set is_active=true where id='00000000-0000-0000-0000-000000000091'$$,
 'P0001', 'Removed accounts cannot be restored', 'Removed workers cannot be re-enabled');
select * from finish();
rollback;
