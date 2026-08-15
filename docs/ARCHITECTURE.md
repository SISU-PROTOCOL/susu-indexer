# Architecture — susu-indexer

> Phase 5 in progress.

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
                                        ├─ decode XDR into typed events
                                        ├─ validate, order, deduplicate
                                        ├─ upsert by event identity
                                        └─ advance checkpoint (forward only)
```

## Guarantees

| Guarantee                | Mechanism                                                                        |
| ------------------------ | -------------------------------------------------------------------------------- |
| No duplicate rows        | Unique `event_identity` (`contractId:ledger:txHash:eventIndex`)                  |
| Stable event identity    | `eventIndex` is the ledger-scoped ordinal from the RPC's paging token            |
| Only successful calls    | Events from failed contract calls are never indexed                              |
| Replay-safe              | Upserts ignore conflicts rather than overwriting                                 |
| No skipped ledgers       | Range resumes at `checkpoint + 1`; checkpoint advances only after writes succeed |
| Bounded runtime          | Range capped at `INDEXER_MAX_LEDGER_RANGE` per run                               |
| Retryable failures       | Bounded exponential backoff; checkpoint untouched on failure                     |
| Not publicly triggerable | Shared secret, constant-time comparison, fails closed                            |
| No credential leakage    | Recursive log redaction; secret read from Vault at call time                     |
| Browser isolation        | RLS enabled with no policies; `anon`/`authenticated` revoked                     |

### Event identity

The RPC does **not** return a per-transaction event index. It returns `id`, a paging token of the
form `<ledger-token>-<ordinal>`, where the ordinal counts events across the whole ledger. The
ordinal is extracted from that token and used as `eventIndex`.

This is worth stating explicitly because the obvious alternative is wrong in a way that only shows
up under pagination. Deriving the index from an event's position within a response page looks
correct until a busy range is split across pages, at which point the same event acquires a different
position, and therefore a different identity, and is indexed a second time.

### Decoding

`decode.ts` turns base64 XDR into typed events and rejects anything it cannot fully recognise. A
payload that is merely _almost_ understood is never coerced into something plausible: an unreadable
amount is not zero, and an event with the wrong number of topics is not a near-miss to be patched
up. Rejected events are counted and skipped; a misread event becomes a wrong balance.

The expected shapes are asserted against bytes captured from Testnet, in
`tests/fixtures/chain_events.json`, so the tests fail if the decoder stops agreeing with what the
contracts actually emit rather than merely with what we assumed they emit.

### Only successful calls

Contract events are emitted during failed calls as well as successful ones. Indexing one would
record a contribution or a payout that never happened, so an event whose emitting call did not
succeed — or whose status the RPC did not state — is not indexed.

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
