# Pull Request

## Summary

<!-- What does this change and why? -->

## Repository

- [ ] `susu-indexer`
- [ ] `susu-contracts`
- [ ] `susu-web`
- [ ] `susu-api`

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor (no behavior change)
- [ ] Documentation
- [ ] CI / tooling
- [ ] Security hardening
- [ ] Database migration

## Indexer integrity

- [ ] This change does **not** alter event identity (`contractId:ledger:txHash:eventIndex`).
- [ ] This change **does** alter event identity — a migration plan for existing rows is included and
      a maintainer approved it.
- [ ] Checkpoints still advance forward only, and only after writes succeed.
- [ ] No ledger can be skipped between consecutive runs.
- [ ] Every loop remains bounded within the execution budget.

## Authority

- [ ] The indexer gains no financial authority and still never signs or submits transactions.

## Database / migration impact

- [ ] No database or migration changes.
- [ ] Database or migration changes included. - [ ] RLS enabled in the same migration; never
      disabled. - [ ] `anon`/`authenticated` privileges explicitly revoked. - [ ] No `USING (true)`
      / `WITH CHECK (true)` policies. - [ ] No secret is written into the migration — Vault is used
      at call time. - [ ] RLS filter and reconciliation columns are indexed.

## Security impact

- [ ] No secret, service-role key, or invocation secret is logged or returned.
- [ ] Invocation authorisation still fails closed.
- [ ] Event validation still rejects malformed data rather than coercing it.
- [ ] No floating-point arithmetic is used for money.

## Testing

- [ ] New or updated tests cover the change, including negative paths.
- [ ] `format`, `lint`, `check`, `test` pass.

## Checklist

- [ ] Docs updated to match the implementation.
- [ ] No claims of being audited, secure, or production-ready were added.
