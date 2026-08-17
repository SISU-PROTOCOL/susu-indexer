-- Susu Protocol — chain-derived financial tables
--
-- Everything here is derived. The chain is authoritative, and if any of this
-- disagrees with it the chain wins and this is rebuilt.
--
-- WHY THERE ARE THREE LAYERS
--   * `indexed_events`  — raw events exactly as the RPC returned them, base64
--     XDR and all. Never interpreted, so it is the evidence of record.
--   * `decoded_events`  — every event the decoder understood, with its fields
--     extracted. The audit trail, and the source a rebuild replays.
--   * the tables below  — the same facts in the shape the application queries,
--     with the invariants the chain enforces (one contribution per member per
--     round, one payout per round) also enforced here, so the writer is not
--     trusted to have got them right.
--
-- MONEY
--   Amounts are i128 stroops on chain, stored as numeric(39,0): the largest
--   i128 is 170141183460469231731687303715884105727, which is 39 digits, so
--   bigint (19 digits) would overflow. Floating point is not an option for
--   money.
--
--   Beware when reading: PostgREST renders `numeric` as a JSON *number*, and
--   JavaScript silently loses precision above 2^53. Any read that crosses into
--   JavaScript must select `amount::text`.
--
-- SECURITY POSTURE
--   Identical to `indexer_core`: RLS is enabled on every table with no policies,
--   so access defaults to deny; `anon` and `authenticated` are revoked outright;
--   only the service role — used exclusively by the trusted indexer function and
--   the API's server side — may touch these tables. No `USING (true)` policy
--   exists anywhere here, and none may be added.

-- ---------------------------------------------------------------------------
-- Decoded events: one row per event the decoder understood.
-- ---------------------------------------------------------------------------
create table if not exists public.decoded_events (
  -- Chain-derived identity, shared with `indexed_events`. Unique, so a replayed
  -- or overlapping range cannot duplicate a fact.
  event_identity text primary key,
  -- Constrained to the events the contracts actually emit, so a name the
  -- decoder does not know cannot be recorded even by a future bug.
  name text not null check (
    name in (
      'group_created', 'fee_updated', 'treasury_updated', 'pause_updated',
      'join', 'start', 'contribution', 'payout', 'fee', 'completed'
    )
  ),
  contract_id text not null,
  ledger bigint not null check (ledger >= 0),
  tx_hash text not null,
  tx_index integer not null check (tx_index >= 0),
  event_index integer not null check (event_index >= 0),
  -- The RPC's own paging token. Kept so an event can be re-fetched by hand.
  event_id text not null,
  -- The decoded fields. Every amount is a base-unit string, never a number.
  payload jsonb not null,
  inserted_at timestamptz not null default now()
);

comment on table public.decoded_events is
  'Every event the decoder understood, with amounts as base-unit strings. Rebuildable from indexed_events.';

-- ---------------------------------------------------------------------------
-- Groups: one row per deployed Group contract, and the indexer's watch list.
-- ---------------------------------------------------------------------------
create table if not exists public.groups (
  contract_id text primary key,
  factory_contract_id text not null,
  -- The factory's own sequential id, unique per factory.
  group_id bigint not null check (group_id > 0),
  creator text not null,
  -- The SAC the group settles in. USDC in practice; recorded, not assumed.
  token text not null,
  contribution_amount numeric(39,0) not null check (contribution_amount > 0),
  member_capacity integer not null check (member_capacity > 0),
  created_ledger bigint not null check (created_ledger >= 0),

  -- Derived state, recomputed from events and repaired by reconciliation.
  status text not null default 'open' check (status in ('open', 'active', 'completed')),
  member_count integer not null default 0 check (member_count >= 0),
  current_round integer not null default 0 check (current_round >= 0),
  completed_rounds integer not null default 0 check (completed_rounds >= 0),
  contributed_total numeric(39,0) not null default 0 check (contributed_total >= 0),
  paid_out_total numeric(39,0) not null default 0 check (paid_out_total >= 0),
  fee_total numeric(39,0) not null default 0 check (fee_total >= 0),
  last_event_ledger bigint not null default 0 check (last_event_ledger >= 0),

  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (factory_contract_id, group_id)
);

comment on table public.groups is
  'Chain-derived groups. Discovery writes the identity; events fill in the state.';

-- ---------------------------------------------------------------------------
-- Group members: one row per `join`, in the position the chain assigned.
-- ---------------------------------------------------------------------------
create table if not exists public.group_members (
  contract_id text not null references public.groups (contract_id) on delete cascade,
  member text not null,
  -- 1-based join order, as emitted by the contract.
  position integer not null check (position > 0),
  joined_ledger bigint not null check (joined_ledger >= 0),
  event_identity text not null,
  primary key (contract_id, member),
  -- Two members cannot share a position.
  unique (contract_id, position)
);

comment on table public.group_members is
  'Membership as the chain recorded it. The position is the contract''s own.';

-- ---------------------------------------------------------------------------
-- Contributions: one row per `contribution`.
-- ---------------------------------------------------------------------------
create table if not exists public.contributions (
  event_identity text primary key,
  contract_id text not null references public.groups (contract_id) on delete cascade,
  member text not null,
  round integer not null check (round > 0),
  amount numeric(39,0) not null check (amount > 0),
  ledger bigint not null check (ledger >= 0),
  tx_hash text not null,
  -- The contract refuses a second contribution from one member in one round, so
  -- a duplicate here means our reading of the events is wrong, not that the
  -- chain allowed it. Enforced rather than assumed.
  unique (contract_id, round, member)
);

comment on table public.contributions is
  'Contributions the chain recorded. Rebuildable; the chain remains authoritative.';

-- ---------------------------------------------------------------------------
-- Payouts: one row per `payout`, the amount the recipient received.
-- ---------------------------------------------------------------------------
create table if not exists public.payouts (
  event_identity text primary key,
  contract_id text not null references public.groups (contract_id) on delete cascade,
  recipient text not null,
  round integer not null check (round > 0),
  recipient_amount numeric(39,0) not null check (recipient_amount > 0),
  ledger bigint not null check (ledger >= 0),
  tx_hash text not null,
  -- One payout per round, by construction.
  unique (contract_id, round)
);

comment on table public.payouts is
  'Payouts the chain recorded, net of the protocol fee.';

-- ---------------------------------------------------------------------------
-- Protocol fees: one row per `fee`, the treasury's share of a payout.
-- ---------------------------------------------------------------------------
create table if not exists public.protocol_fees (
  event_identity text primary key,
  contract_id text not null references public.groups (contract_id) on delete cascade,
  treasury text not null,
  round integer not null check (round > 0),
  fee numeric(39,0) not null check (fee >= 0),
  ledger bigint not null check (ledger >= 0),
  tx_hash text not null,
  unique (contract_id, round)
);

comment on table public.protocol_fees is
  'The protocol fee taken from each payout. Fee plus recipient amount equals the pot.';

-- ---------------------------------------------------------------------------
-- Indexes for the queries the API actually makes.
-- ---------------------------------------------------------------------------
create index if not exists decoded_events_contract_ledger_idx
  on public.decoded_events (contract_id, ledger);
create index if not exists decoded_events_name_ledger_idx
  on public.decoded_events (name, ledger);
create index if not exists decoded_events_ledger_idx
  on public.decoded_events (ledger);

create index if not exists groups_status_idx
  on public.groups (status);

create index if not exists group_members_member_idx
  on public.group_members (member);

create index if not exists contributions_member_idx
  on public.contributions (member);

create index if not exists payouts_recipient_idx
  on public.payouts (recipient);

-- ---------------------------------------------------------------------------
-- Row Level Security: enabled, with no policies (deny by default).
-- ---------------------------------------------------------------------------
alter table public.decoded_events enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.contributions enable row level security;
alter table public.payouts enable row level security;
alter table public.protocol_fees enable row level security;

-- ---------------------------------------------------------------------------
-- Grants: browser roles get nothing; RLS is not a substitute for grants.
-- ---------------------------------------------------------------------------
-- Re-created here so this migration stands alone. A no-op against a real
-- project and against `indexer_core`, which creates the same roles.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

revoke all on public.decoded_events from anon, authenticated;
revoke all on public.groups from anon, authenticated;
revoke all on public.group_members from anon, authenticated;
revoke all on public.contributions from anon, authenticated;
revoke all on public.payouts from anon, authenticated;
revoke all on public.protocol_fees from anon, authenticated;

-- The service role is the indexer and the API's server side. Deliberately no
-- DELETE: reconciliation repairs by upsert, and removing a fact that should
-- never have existed is an operator's decision, not the writer's.
grant select, insert on public.decoded_events to service_role;
grant select, insert, update on public.groups to service_role;
grant select, insert, update on public.group_members to service_role;
grant select, insert, update on public.contributions to service_role;
grant select, insert, update on public.payouts to service_role;
grant select, insert, update on public.protocol_fees to service_role;
