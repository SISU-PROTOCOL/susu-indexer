-- Susu Protocol — indexer core tables
--
-- These tables are owned by the indexer. They are NOT chain-derived financial
-- records (those live in `contributions`, `payouts` and `transactions`, added in
-- Phase 5), and they are NOT user data. They are operational state for the
-- indexing pipeline.
--
-- SECURITY POSTURE
--   * RLS is enabled on every table here. No policies are created, so access
--     defaults to deny for every role subject to RLS.
--   * `anon` and `authenticated` are explicitly revoked. Browser clients must
--     have no read or write access to index state.
--   * Only `service_role` (which bypasses RLS and is used exclusively by the
--     trusted indexer Edge Function) may access these tables.
--   * No `USING (true)` / `WITH CHECK (true)` policies exist anywhere here.
--
-- This migration never disables RLS. A later migration must not either.

-- ---------------------------------------------------------------------------
-- Checkpoints: the last fully processed ledger.
-- ---------------------------------------------------------------------------
create table if not exists public.indexer_checkpoints (
  id text primary key,
  last_processed_ledger bigint not null check (last_processed_ledger >= 0),
  start_ledger bigint not null check (start_ledger >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.indexer_checkpoints is
  'Indexer-owned checkpoint. Chain state is authoritative; this records indexing progress only.';

-- ---------------------------------------------------------------------------
-- Indexed events: raw chain events, deduplicated by chain-assigned identity.
-- ---------------------------------------------------------------------------
create table if not exists public.indexed_events (
  -- Ledger, transaction index, event index and tx hash form the chain-derived
  -- identity. Unique, so replays and overlapping ranges cannot duplicate rows.
  event_identity text primary key,
  ledger bigint not null check (ledger >= 0),
  tx_hash text not null,
  tx_index integer not null check (tx_index >= 0),
  event_index integer not null check (event_index >= 0),
  contract_id text not null,
  topic jsonb not null default '[]'::jsonb,
  value text not null,
  inserted_at timestamptz not null default now()
);

comment on table public.indexed_events is
  'Raw Soroban events indexed by the scheduled indexer. Rebuildable from chain history.';

-- Indexes supporting range scans, reconciliation and lag queries.
create index if not exists indexed_events_ledger_idx
  on public.indexed_events (ledger);
create index if not exists indexed_events_contract_ledger_idx
  on public.indexed_events (contract_id, ledger);
create index if not exists indexed_events_tx_hash_idx
  on public.indexed_events (tx_hash);

-- ---------------------------------------------------------------------------
-- Run log: operational visibility for scheduled runs.
-- ---------------------------------------------------------------------------
create table if not exists public.indexer_runs (
  id uuid primary key default gen_random_uuid(),
  correlation_id text not null,
  ledger_from bigint not null check (ledger_from >= 0),
  ledger_to bigint not null check (ledger_to >= 0),
  status text not null check (status in ('ok', 'failed', 'skipped')),
  -- Truncated error text. Must never contain credentials.
  reason text,
  created_at timestamptz not null default now()
);

comment on table public.indexer_runs is
  'Append-only log of indexer runs, used for monitoring stale checkpoints and failed scheduled runs.';

create index if not exists indexer_runs_created_at_idx
  on public.indexer_runs (created_at desc);
create index if not exists indexer_runs_status_created_at_idx
  on public.indexer_runs (status, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security: enabled, with no policies (deny by default).
-- ---------------------------------------------------------------------------
alter table public.indexer_checkpoints enable row level security;
alter table public.indexed_events enable row level security;
alter table public.indexer_runs enable row level security;

-- ---------------------------------------------------------------------------
-- Grants: browser roles get nothing; RLS is not a substitute for grants.
-- ---------------------------------------------------------------------------
revoke all on public.indexer_checkpoints from anon, authenticated;
revoke all on public.indexed_events from anon, authenticated;
revoke all on public.indexer_runs from anon, authenticated;

grant select, insert, update on public.indexer_checkpoints to service_role;
grant select, insert, update on public.indexed_events to service_role;
grant select, insert on public.indexer_runs to service_role;
