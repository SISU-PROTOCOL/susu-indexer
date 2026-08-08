# Architecture — susu-indexer

> Phase 0 draft.

## Role

The indexer converts chain activity into queryable index state. It is a **consumer** of chain data,
never a participant in financial decisions.

```text
Stellar RPC ──events──> Indexer Edge Function ──upsert──> PostgreSQL
                              │
                              ├─ checkpoint (last fully processed ledger)
                              ├─ event identity (idempotent key)
                              └─ run log (operational visibility)
```

## Invocation model

```text
Supabase Cron (every 5 minutes)
   │  reads secret from Vault
   ▼
public.invoke_indexer()  ──HTTP──>  Edge Function `indexer`
                                        │
                                        ├─ authorise (constant-time secret compare)
                                        ├─ load checkpoint + chain tip
                                        ├─ compute bounded ledger range
                                        ├─ fetch events (paginated, retried)
                                        ├─ validate, order, deduplicate
                                        ├─ upsert by event identity
                                        └─ advance checkpoint (forward only)
```

## Guarantees

| Guarantee                | Mechanism                                                                        |
| ------------------------ | -------------------------------------------------------------------------------- |
| No duplicate rows        | Unique `event_identity` (`contractId:ledger:txHash:eventIndex`)                  |
| Replay-safe              | Upserts ignore conflicts rather than overwriting                                 |
| No skipped ledgers       | Range resumes at `checkpoint + 1`; checkpoint advances only after writes succeed |
| Bounded runtime          | Range capped at `INDEXER_MAX_LEDGER_RANGE` per run                               |
| Retryable failures       | Bounded exponential backoff; checkpoint untouched on failure                     |
| Not publicly triggerable | Shared secret, constant-time comparison, fails closed                            |
| No credential leakage    | Recursive log redaction; secret read from Vault at call time                     |
| Browser isolation        | RLS enabled with no policies; `anon`/`authenticated` revoked                     |

## Storage

| Table                 | Purpose                                                  |
| --------------------- | -------------------------------------------------------- |
| `indexer_checkpoints` | Last fully processed ledger and rebuild origin           |
| `indexed_events`      | Raw chain events, deduplicated by chain-derived identity |
| `indexer_runs`        | Append-only run log for monitoring and alerting          |

These are operational tables, not financial records. Chain-derived financial tables
(`contributions`, `payouts`, `transactions`) are added in Phase 5 and follow the same restrictions:
written only by trusted server paths, never by browser clients.

## Deliberate non-goals

- No transaction submission or signing.
- No financial authority of any kind.
- No always-on worker for the MVP — scheduled execution is sufficient given idempotent, resumable
  runs.
