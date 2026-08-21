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

A group's derived figures are recomputed from its recorded facts on every run, and a disagreement
with what was stored is logged as
`Group state disagreed with the recorded facts; repaired from
them`, with a `divergences` count and
up to five `examples` naming the field, the stored value, and the derived one.

1. Read the logged divergence.
2. If a fact is missing rather than wrong, the fault is in discovery or paging rather than in state
   derivation — re-indexing repairs the symptom, but the cause is the bug to fix.
3. Confirm the repaired figures against chain state.

### A group's activity is missing or incomplete

A group is only ever learned about from the Factory's `group_created` event, and only from inside a
range that is read. The checkpoint has already moved past that range by the time the symptom is
visible, so a rebuild is required. Two distinct faults produce the same symptom:

- the range was processed before group discovery existed, so the group's contract was never watched;
- the range was read incompletely, so some of its events were never fetched.

1. Confirm the group exists on-chain and note its creation ledger.
2. Reset the checkpoint to the ledger **before** that group's creation ledger (see below).
3. Let runs work forward, then confirm the group appears in `groups` with its facts in
   `group_members`, `contributions`, `payouts` and `protocol_fees`.

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
4. Optionally truncate `indexed_events` and the chain-derived tables (`decoded_events`, `groups`,
   `group_members`, `contributions`, `payouts`, `protocol_fees`) first if a clean rebuild is
   preferred — the indexer repopulates all of them. Never truncate anything the contracts depend on;
   nothing off-chain is a dependency of the contracts.

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
