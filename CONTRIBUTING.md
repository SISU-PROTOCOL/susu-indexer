# Contributing to the Susu Indexer

Thanks for your interest. This service writes the data other components read, so correctness and
idempotency are the priority.

## Before you start

- Read `README.md` and `SECURITY.md`.
- Anything touching event identity, checkpointing, or RLS/grants needs maintainer review first. Open
  an issue before a PR.

## Ground rules

1. **Never** give the indexer financial authority. It observes; it never decides or signs.
2. **Never** change the event identity format without a migration plan — it would orphan previously
   indexed rows.
3. **Never** advance a checkpoint before the corresponding writes have succeeded.
4. **Never** allow a checkpoint to move backwards.
5. **Never** use floating-point arithmetic for money.
6. **Never** log or return the service-role key or the invocation secret.
7. **Never** disable RLS or grant browser roles access to index tables.
8. Keep loops bounded. Every invocation must terminate within its execution budget.

## Development setup

```bash
cp .env.example .env
deno task check
deno task lint
deno task test
```

## Testing requirements

Add tests for new logic, including negative paths. At minimum, cover:

- Event identity stability and collision resistance across contracts, ledgers, transactions, and
  event indices.
- Ledger range computation, including the "never skip a ledger" property and caught-up runs.
- Checkpoint advancement, including refusal to regress.
- Validation rejecting malformed amounts, contract ids, and transaction hashes.
- Secret redaction at depth.

## Migrations

Every migration that creates or alters an exposed table must:

- [ ] Enable RLS in the same migration.
- [ ] Revoke `anon`/`authenticated` privileges explicitly.
- [ ] Avoid `USING (true)` / `WITH CHECK (true)` policies.
- [ ] Keep secrets out of the file — read them from Vault at call time.

## Commit messages

Clear, imperative subject lines. Reference issues where applicable. Do not add co-author trailers
for tooling.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
