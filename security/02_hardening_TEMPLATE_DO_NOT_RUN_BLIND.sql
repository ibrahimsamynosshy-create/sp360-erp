-- =====================================================================
-- SP360 — Hardening templates. REVIEW ONLY. Do not run until 01 results are
-- reviewed; adapt table names. Run first on a Supabase branch / staging copy.
-- Owner approval required (Ibrahim) before production.
-- =====================================================================

-- 1) Block role / is_active self-escalation on user_profiles
--    Users may edit their own name/initials/color only; role changes only by Admin/PMO.
create or replace function public.fn_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_profiles
                 where id = auth.uid() and is_active and role in ('Admin','PMO Manager'));
$$;
revoke all on function public.fn_is_admin() from public, anon;
grant execute on function public.fn_is_admin() to authenticated;

create or replace function public.trg_protect_profile_privileges() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.role is distinct from old.role or new.is_active is distinct from old.is_active)
     and not public.fn_is_admin() then
    raise exception 'Only Admin/PMO Manager can change role or active status';
  end if;
  return new;
end $$;
drop trigger if exists protect_profile_privileges on public.user_profiles;
create trigger protect_profile_privileges before update on public.user_profiles
  for each row execute function public.trg_protect_profile_privileges();

-- 2) Remove all anon table access (internal ERP: everything requires sign-in)
-- revoke all on all tables in schema public from anon;
-- alter default privileges in schema public revoke all on tables from anon;

-- 3) Restrictive MFA policy pattern for sensitive tables (repeat per table)
-- create policy "mfa_required" on public.invoices as restrictive for all to authenticated
--   using ((auth.jwt()->>'aal') = 'aal2') with check ((auth.jwt()->>'aal') = 'aal2');

-- 4) Role-scoped access pattern (replace USING (true) policies). Example: finance tables.
-- create or replace function public.fn_has_role(r text[]) returns boolean
-- language sql stable security definer set search_path = public as $$
--   select exists(select 1 from public.user_profiles where id=auth.uid() and is_active and role = any(r)); $$;
-- drop policy if exists "<broad policy name>" on public.invoices;
-- create policy invoices_read on public.invoices for select to authenticated
--   using (public.fn_has_role(array['Admin','PMO Manager','CEO','Finance Manager']));

-- 5) Views: make them respect the caller's RLS
-- alter view public.v_ai_insights_pending set (security_invoker = true);

-- 6) Pin search_path on every SECURITY DEFINER function flagged in query E
-- alter function public.<fn>(<args>) set search_path = public;

-- 7) Audit log must be append-only
-- revoke update, delete on public.audit_log from authenticated;
