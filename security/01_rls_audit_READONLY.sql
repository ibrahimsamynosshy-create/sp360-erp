-- =====================================================================
-- SP360 — Security audit (READ-ONLY). Run in Supabase SQL Editor for
-- project sqizirpsatofcoqshwer. Changes nothing. Paste results back to Claude.
-- =====================================================================

-- A. Tables in exposed schemas WITHOUT RLS  (any row here = CRITICAL)
select n.nspname as schema, c.relname as table_name, c.relrowsecurity as rls_on, c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r','p') and n.nspname in ('public','storage')
  and not c.relrowsecurity
order by 1,2;

-- B. Every policy, flagged when it is too broad
select schemaname, tablename, policyname, cmd, roles, permissive,
       qual        as using_expr,
       with_check  as check_expr,
       case
         when 'anon' = any(roles) or 'public' = any(roles) then 'REVIEW: anon/public role'
         when coalesce(qual,'') in ('true','(true)') and cmd in ('ALL','UPDATE','DELETE','INSERT') then 'HIGH: unrestricted write'
         when coalesce(qual,'') in ('true','(true)') then 'MEDIUM: any signed-in user reads all rows'
         when cmd in ('INSERT','UPDATE','ALL') and with_check is null and cmd <> 'UPDATE' then 'REVIEW: no WITH CHECK'
         else 'ok?'
       end as flag
from pg_policies
where schemaname in ('public','storage')
order by flag, tablename, cmd;

-- C. Tables with RLS ON but ZERO policies (locked out — or relying on service_role)
select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r' and c.relrowsecurity
  and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname);

-- D. Privilege escalation check: can a user UPDATE their own user_profiles.role?
select policyname, cmd, roles, qual, with_check
from pg_policies where tablename = 'user_profiles';
select grantee, privilege_type, column_name
from information_schema.column_privileges
where table_schema='public' and table_name='user_profiles' and column_name in ('role','is_active')
  and grantee in ('anon','authenticated');

-- E. SECURITY DEFINER functions callable by anon/authenticated (check search_path + role checks inside)
select p.proname, pg_get_function_identity_arguments(p.oid) args, p.prosecdef as security_definer,
       p.proconfig as settings,  -- should contain search_path=...
       has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
order by p.prosecdef desc, anon_exec desc, p.proname;

-- F. Table grants to anon (should be empty for an internal ERP)
select table_name, string_agg(privilege_type, ',') privs
from information_schema.role_table_grants
where table_schema='public' and grantee='anon'
group by table_name order by 1;

-- G. Views that bypass RLS (security_invoker not set)
select c.relname as view_name, c.reloptions
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='v'
  and not coalesce(c.reloptions::text ilike '%security_invoker=true%', false);

-- H. Storage buckets (public = readable by anyone with the URL)
select id, name, public, file_size_limit, allowed_mime_types from storage.buckets;

-- I. MFA enforcement in RLS (expect policies referencing aal2 on sensitive tables)
select tablename, policyname from pg_policies
where qual ilike '%aal%' or with_check ilike '%aal%' or permissive = 'RESTRICTIVE';

-- J. Realtime publication — which tables broadcast changes
select schemaname, tablename from pg_publication_tables where pubname='supabase_realtime';
