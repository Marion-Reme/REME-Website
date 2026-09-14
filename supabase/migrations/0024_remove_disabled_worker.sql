-- Keep identity rows for assignment, photo and audit history when Auth removes access.
alter table public.user_profile add column deleted_at timestamptz;

create or replace function public.sync_removed_worker()
returns trigger language plpgsql security definer set search_path = '' as $$
declare profile public.user_profile;
begin
  select * into profile from public.user_profile where id = new.id for update;
  if profile.role = 'worker' then
    if profile.is_active then
      raise exception 'Disable the worker before removing their account';
    end if;
    update public.user_profile
    set deleted_at = new.deleted_at,
        email = id::text || '@removed.invalid', phone = null
    where id = new.id;
  end if;
  return new;
end $$;
revoke all on function public.sync_removed_worker() from public;
create trigger auth_user_removed_worker
  after update of deleted_at on auth.users
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.sync_removed_worker();

-- Prevent a concurrent re-enable, including direct API updates, from restoring access.
create or replace function public.protect_removed_profile()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.deleted_at is not null and
     (new.is_active or new.deleted_at is distinct from old.deleted_at) then
    raise exception 'Removed accounts cannot be restored';
  end if;
  if new.deleted_at is distinct from old.deleted_at and
     not exists (select 1 from auth.users where id = new.id and deleted_at is not null) then
    raise exception 'Remove the Auth account first';
  end if;
  return new;
end $$;
-- Run with owner permissions to inspect the protected Auth table.
alter function public.protect_removed_profile() security definer;
revoke all on function public.protect_removed_profile() from public;
create trigger user_profile_protect_removed
  before update on public.user_profile for each row
  execute function public.protect_removed_profile();
