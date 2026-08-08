# Runbook — susu-indexer

Operational procedures for the scheduled indexer.

## Core principle

The index is a **rebuildable cache** of chain activity. Chain state is authoritative. If the two
disagree, the chain is correct and the index is repaired — never the other way round.

## Health signals

- **Checkpoint:** `select * from indexer_checkpoints;`
- **Lag:** compare `last_processed_ledger` to the network's current ledger.
- **Failed runs:**
  `select * from indexer_runs where status = 'failed' order by created_at desc limit 20;`
- **Cron history:**
  `select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'susu-indexer') order by start_time desc limit 20;`

A checkpoint that stops advancing, or a growing lag, means scheduled runs are failing or cannot keep
up.

## Procedures

### The checkpoint is stale

1. Check `indexer_runs` for failure reasons.
2. Confirm the RPC endpoint is reachable and the Supabase function is deployed.
3. Confirm the invocation secret in Vault matches `INDEXER_TASK_SECRET` on the function.
4. Trigger a run manually (see below) and confirm the checkpoint advances.

A missed schedule is **not** data loss: the next run resumes from the checkpoint and retries the
whole unprocessed range.

### Trigger a run manually

```bash
curl -i --fail-with-body \
  -X POST "$SUPABASE_URL/functions/v1/indexer" \
  -H "x-indexer-task-secret: $INDEXER_TASK_SECRET" \
  -H "content-type: application/json" \
  -d '{}'
```

Never paste the secret into a shared terminal history or a log. Prefer exporting it from a secret
manager for the duration of the command.

### Runs are failing repeatedly

1. Read the `reason` column — it names the failure class, never a credential.
2. If it is an RPC fault, wait for retry; backoff is bounded per run.
3. If it is a validation fault, an event shape may have changed. Do **not** loosen validation to
   force the run through — a bad amount must never be coerced into a valid one. Escalate.

### Index state diverges from chain state

1. Identify the affected range from the checkpoint and the contract's ledger.
2. Inspect the transactions and events on-chain first. Assume the chain is correct.
3. Repair by re-indexing the range: reset the checkpoint to the ledger **before** the divergence and
   let the indexer re-scan. Event identity makes this idempotent.
4. Verify the repaired rows against chain state.

### Full rebuild

1. Note the Factory deployment ledger.
2. Reset the checkpoint:
   ```sql
   update public.indexer_checkpoints
   set last_processed_ledger = :deployment_ledger - 1,
       start_ledger = :deployment_ledger
   where id = 'default';
   ```
3. Let scheduled runs work through the history. Progress is durable between runs.
4. Optionally truncate `indexed_events` first if a clean rebuild is preferred — the indexer will
   repopulate it. Never truncate anything the contracts depend on; nothing off-chain is a dependency
   of the contracts.

### The invocation secret is compromised

1. Generate a new secret (`openssl rand -hex 32`).
2. Update the Edge Function secret and the Vault entry.
3. Confirm the old secret is rejected.
4. Review `indexer_runs` and function logs for unauthorised invocations.

### Pausing indexing

```sql
select cron.unschedule('susu-indexer');
```

Indexing resumes from the checkpoint whenever the schedule is restored.

## Escalation

Any change to event identity, checkpoint semantics, or index table access requires human review
before implementation. Never weaken validation or RLS to work around an operational problem.
