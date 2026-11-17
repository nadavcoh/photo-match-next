-- Sign-up restriction by GitHub user id instead of email address.
--
-- public.restrict_signup is the Supabase Auth "Before User Created" hook (Dashboard:
-- Authentication > Hooks). It runs only when an account is about to be created, so
-- the existing owner account is not affected. It now lets a sign-up through only if
-- it comes from GitHub (app_metadata.provider, set by the auth server) and the GitHub
-- user id equals the owner's. The id is read from user_metadata.provider_id (falling
-- back to user_metadata.sub). user_metadata alone is not trusted: on an email
-- sign-up the caller controls it, which is why the provider check comes first.
--
-- CREATE OR REPLACE keeps the function's owner and grants (execute for
-- supabase_auth_admin) unchanged. Same security attributes as before.

create or replace function public.restrict_signup(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider  text := event -> 'user' -> 'app_metadata' ->> 'provider';
  v_github_id text := coalesce(
    event -> 'user' -> 'user_metadata' ->> 'provider_id',
    event -> 'user' -> 'user_metadata' ->> 'sub'
  );
begin
  if v_provider is distinct from 'github'
     or v_github_id is distinct from '29537286' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'message', 'Signups are restricted to the app owner only.',
        'http_code', 403
      )
    );
  end if;

  return event;
end;
$$;
