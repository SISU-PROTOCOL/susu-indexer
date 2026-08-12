# Susu Protocol — Indexer

[![CI](https://github.com/SISU-PROTOCOL/susu-indexer/actions/workflows/ci.yml/badge.svg)](https://github.com/SISU-PROTOCOL/susu-indexer/actions/workflows/ci.yml)

Scheduled blockchain indexer for **Susu Protocol**. It reads Soroban contract events, records them
idempotently in PostgreSQL, and maintains a resumable checkpoint.

> **Status: Phase 0 — scaffolding.** The pipeline, checkpointing and security guards are in place;
> event decoding for the full contract interface lands in Phase 5. Nothing here is audited.

## What it is not

The indexer is a **reader** of chain state and a **writer** to index tables. It is **not** a
financial authority:

- It never decides balances, payout recipients, eligibility, or authorization.
- It never signs or submits transactions.
- It cannot move funds.
- If index state ever conflicts with chain state, **the chain wins** and reconciliation repairs the
  index.

## Why these design choices

### Factory + separate Group contract

Each Susu group controls its own pool in its own contract. The indexer therefore watches the Factory
for group creation and follows each group's events, rather than assuming a single shared contract
holds all state.

### Supabase Cron + Edge Function, not a paid worker

The MVP must not depend on a paid always-on background worker. Supabase Cron invokes this Edge
Function on a schedule. This is safe because runs are **idempotent and resumable**:

- Events are keyed by a chain-derived identity (`contractId:ledger:txHash:eventIndex`) with a unique
  constraint, so replays and overlapping ranges never duplicate rows.
- The checkpoint only advances **forward**, and only **after** writes succeed — so a failed or
  missed run retries the same range instead of skipping ledgers.
- A run that is already caught up exits without writing.

A dedicated always-on worker is a later production optimization, not an MVP requirement.

### Bounded runs

Each invocation processes at most `INDEXER_MAX_LEDGER_RANGE` ledgers and exits, so it stays within
its execution budget. Progress is durable; the next run continues where this one stopped.

## Layout

```text
supabase/
  functions/
    indexer/index.ts        # scheduled entrypoint
    _shared/
      auth.ts               # constant-time invocation authorisation
      checkpoint.ts         # ledger ranges, checkpoint advancement, lag
      config.ts             # environment validation
      db.ts                 # index tables + checkpoint persistence
      events.ts             # event identity, validation, ordering, dedup
      logger.ts             # structured logging with recursive redaction
      money.ts              # integer-only fee/recipient verification
      retry.ts              # bounded exponential backoff
      stellar.ts            # minimal read-only Soroban RPC client
  migrations/               # schema, RLS, grants
scripts/
  schedule-indexer.sql      # cron schedule (reads its secret from Vault)
tests/                      # Deno tests
```

## Money

`money.ts` performs **verification only** — it never decides an amount. All arithmetic is integer
(`bigint`) stroops; floating point is never used for money.

```text
fee              = amount * fee_bps / 10_000     (integer division, truncated)
recipient_amount = amount - fee
fee_bps          = 50
fee + recipient_amount == pool
```

The canonical check is 3 members × 10 USDC = 30 USDC → fee 0.15 USDC, recipient 29.85 USDC.

## Database security

Index tables are **server-owned**. RLS is enabled with no policies (deny by default), and
`anon`/`authenticated` privileges are explicitly revoked. Only the service role — used exclusively
by this function — can access them. RLS is never a substitute for grants, so both are enforced, and
CI verifies both, including that browser roles hold no table privileges at all.

The cron schedule reads its secret from **Vault** at call time, so no credential is written into the
migration, into `cron.job`, or into source control.

## Development

Requires Deno and the Supabase CLI.

```bash
cp .env.example .env
deno task check
deno task lint
deno task test
```

## Operations

- **Stale checkpoint:** check `indexer_runs` for failures, then confirm RPC reachability. Restarting
  resumes from the checkpoint automatically.
- **Full rebuild:** reset `indexer_checkpoints` to the deployment ledger and let the indexer
  re-scan. Event identity makes this safe.
- **Reconciliation:** compare index state against contract state; the chain is authoritative.

See [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Security

Unaudited. See [`SECURITY.md`](SECURITY.md) for reporting.

## License

[MIT](LICENSE)
