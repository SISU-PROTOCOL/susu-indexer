# Security Policy

## Status

The Susu Protocol indexer is **in active development and has not been audited**. It targets Stellar
**Testnet only**. Do not use it with real funds.

We do not claim this software is secure, audited, or production-ready.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately using GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, or email the maintainers listed in `CODEOWNERS`.

Include a description, reproduction steps or a proof of concept, the affected commit, and any
suggested remediation. We aim to acknowledge reports within **72 hours**.

## In scope

- Exposure of the service-role key or the invocation secret to a client, a response, or a log.
- Unauthenticated invocation of the indexer function, or a timing side channel in secret comparison.
- Event identity collisions that let a replay overwrite or duplicate indexed data.
- Checkpoint regression or skipped ledger ranges that cause events to be missed silently.
- RLS or grant weaknesses on index tables.
- Unbounded loops, memory growth, or resource exhaustion from crafted event data.
- RPC response handling that trusts attacker-influenced data without validation.
- Any path that grants the indexer financial authority.

## Out of scope

- Contract-level vulnerabilities (report in `susu-contracts`).
- Web client vulnerabilities (report in `susu-web`).
- Backend API vulnerabilities (report in `susu-api`).
- Dependencies (report upstream).
- Stellar/Soroban network issues (report upstream).
- Issues requiring an already-compromised service-role key.

## Non-negotiables

- The indexer is **never** a financial authority and **never** signs transactions.
- Chain state is authoritative; the index is rebuildable and always secondary.
- Runs are idempotent; replays must never duplicate or overwrite indexed data.
- The checkpoint advances forward only, and only after successful writes.
- Money is never computed with floating-point arithmetic.
- Service-role credentials and the invocation secret never reach a client or a log.

## Disclosure

We follow coordinated disclosure and will publish an advisory once a fix is available.
