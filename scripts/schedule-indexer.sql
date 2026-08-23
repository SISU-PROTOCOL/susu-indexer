-- Susu Protocol — schedule the indexer Edge Function
--
-- Run this against the Supabase project AFTER deploying the `indexer` function
-- and storing its shared secret.
--
-- For the MVP and Testnet there is no paid always-on worker: Supabase Cron
-- invokes the Edge Function on a schedule. A missed or failed run is safe — the
-- next run resumes from the persisted checkpoint, and the range is retried.
--
-- PREREQUISITES
--   1. `pg_cron` and `pg_net` extensions are enabled.
--   2. The function is deployed as `indexer`.
--   3. Store the shared secret in Vault (see below). Do NOT inline it here:
--      this file is committed, and a secret in source is a leaked secret.
--
-- OPERATOR STEPS (run once, by hand, with a secret that is never committed)
--
--   select vault.create_secret('<the-indexer-task-secret>', 'indexer_task_secret',
--                              'Authorises scheduled indexer invocations');
--
--   -- If the project URL is not already stored:
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url',
--                              'Supabase project URL');
--
-- The secret must match the `INDEXER_TASK_SECRET` environment variable of the
-- deployed function.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- Invocation helper.
--
-- Reads the secret and project URL from Vault at call time, so no credential is
-- written into this migration, into cron.job, or into source control.
-- ---------------------------------------------------------------------------
create or replace function public.invoke_indexer()
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  project_url text;
  task_secret text;
  request_id bigint;
begin
  select decrypted_secret into project_url
  from vault.decrypted_secrets
  where name = 'project_url'
  limit 1;

  select decrypted_secret into task_secret
  from vault.decrypted_secrets
  where name = 'indexer_task_secret'
  limit 1;

  if project_url is null or task_secret is null then
    raise exception
      'Missing Vault secrets: project_url and indexer_task_secret are both required.';
  end if;

  select net.http_post(
    url := project_url || '/functions/v1/indexer',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-indexer-task-secret', task_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into request_id;

  return request_id;
end;
$$;

comment on function public.invoke_indexer() is
  'Invokes the scheduled indexer Edge Function with the shared task secret read from Vault.';

-- Only the scheduler runs this. Browsers never call it.
revoke all on function public.invoke_indexer() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Schedule: every 5 minutes.
--
-- Adjust to the network and RPC quota. Runs overlap safely: the checkpoint only
-- advances forward, event upserts are idempotent, and a run that finds nothing
-- new exits without writing.
--
-- Re-running this script is safe. `cron.schedule` with a name that already
-- exists would raise, and silently adding a second job under the same name would
-- double the invocation rate, so the existing job is removed first. The guard is
-- explicit because `cron.unschedule` errors when the name is unknown.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'susu-indexer') then
    perform cron.unschedule('susu-indexer');
  end if;
end $$;

select cron.schedule(
  'susu-indexer',
  '*/5 * * * *',
  $$select public.invoke_indexer();$$
);

-- ---------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------
-- Inspect the schedule:
--   select * from cron.job where jobname = 'susu-indexer';
--
-- Inspect recent runs:
--   select * from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'susu-indexer')
--   order by start_time desc limit 20;
--
-- Remove the schedule:
--   select cron.unschedule('susu-indexer');
