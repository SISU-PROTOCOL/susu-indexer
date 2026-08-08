/**
 * Susu Protocol indexer — scheduled Supabase Edge Function.
 *
 * Invoked by Supabase Cron (or manually by an operator). It reads Soroban
 * contract events, records them idempotently, and advances a checkpoint.
 *
 * DESIGN CONSTRAINTS
 * - The indexer is **not** a financial authority. It observes; it never decides
 *   balances, recipients, eligibility, or authorization, and it never signs.
 * - Chain state is authoritative. If index state conflicts with chain state,
 *   the chain wins and reconciliation repairs the index.
 * - Runs are idempotent, resumable, and safely retryable. A missed schedule is
 *   not data loss: the next run resumes from the persisted checkpoint.
 * - No paid always-on worker is required for the MVP.
 *
 * SECURITY
 * - Every invocation must present the shared task secret. This function is not
 *   publicly triggerable.
 * - The service-role key is used only here, server-side, and is never logged or
 *   returned.
 */

import { authorizeInvocation } from '../_shared/auth.ts';
import { canAdvanceCheckpoint, computeLedgerRange, ledgerLag } from '../_shared/checkpoint.ts';
import { type IndexerConfig, loadConfig } from '../_shared/config.ts';
import { type IndexedEventRow, IndexerDb } from '../_shared/db.ts';
import { buildEventIdentity, compareEventOrder, dedupeByIdentity } from '../_shared/events.ts';
import { createLogger } from '../_shared/logger.ts';
import { withRetry } from '../_shared/retry.ts';
import { type RpcEvent, SorobanRpcClient } from '../_shared/stellar.ts';

/** Maximum events requested from RPC per page. */
const RPC_PAGE_LIMIT = 100;

/** Bounded retry policy for transient RPC and database failures. */
const RETRY = { attempts: 4, baseDelayMs: 250, maxDelayMs: 4_000 } as const;

type RunSummary = {
  status: 'ok' | 'skipped' | 'failed';
  correlationId: string;
  ledgerFrom?: number;
  ledgerTo?: number;
  eventsIndexed?: number;
  checkpoint?: number;
  lag?: number;
  reason?: string;
};

function jsonResponse(body: RunSummary, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Maps a raw RPC event onto an index row, deriving its chain-assigned identity. */
export function toIndexedRow(event: RpcEvent): IndexedEventRow {
  return {
    event_identity: buildEventIdentity(event),
    ledger: event.ledger,
    tx_hash: event.txHash,
    tx_index: event.txIndex,
    event_index: event.eventIndex,
    contract_id: event.contractId,
    topic: [...event.topic],
    value: event.value,
  };
}

/**
 * Fetches every page of events for a ledger range.
 *
 * Pagination is followed until the RPC stops returning data or the range is
 * exhausted, so a busy range is fully indexed rather than silently truncated.
 */
async function fetchRangeEvents(
  rpc: SorobanRpcClient,
  config: IndexerConfig,
  from: number,
  to: number,
): Promise<RpcEvent[]> {
  const collected: RpcEvent[] = [];
  let startLedger = from;

  // Bounded: the range is already clamped by maxLedgersPerRun, and each
  // iteration must strictly advance or the loop exits.
  while (startLedger <= to) {
    const page = await withRetry(
      () =>
        rpc.getEvents({
          startLedger,
          endLedger: to + 1,
          contractIds: [config.factoryContractId, config.usdcContractId],
          limit: RPC_PAGE_LIMIT,
        }),
      RETRY,
    );

    if (page.events.length === 0) break;

    collected.push(...page.events);

    const highest = page.events.reduce(
      (max, event) => (event.ledger > max ? event.ledger : max),
      startLedger,
    );

    // Advance past the highest ledger seen. Stop if progress is impossible,
    // which prevents an infinite loop if the RPC keeps returning the same page.
    const nextStart = highest > startLedger ? highest : startLedger + 1;
    if (nextStart <= startLedger) break;
    startLedger = nextStart;
  }

  return collected;
}

export async function handleRequest(request: Request): Promise<Response> {
  const correlationId = crypto.randomUUID();
  const logger = createLogger(correlationId);

  const configResult = loadConfig();
  if (!configResult.ok) {
    // Report which variables are problematic — never their values.
    const reason = `invalid configuration (missing: ${
      configResult.missing.join(', ') || 'none'
    }; invalid: ${configResult.invalid.join(', ') || 'none'})`;
    logger.error('Indexer configuration is invalid', { reason });
    return jsonResponse({ status: 'failed', correlationId, reason }, 500);
  }

  const config = configResult.config;

  const auth = authorizeInvocation(request.headers, config.taskSecret);
  if (!auth.authorized) {
    logger.warn('Rejected unauthorised indexer invocation', { reason: auth.reason });
    return jsonResponse({ status: 'failed', correlationId, reason: 'unauthorized' }, 401);
  }

  const db = new IndexerDb(config.supabaseUrl, config.serviceRoleKey);
  const rpc = new SorobanRpcClient(config.rpcUrl);

  try {
    const checkpoint = await withRetry(() => db.getCheckpoint(), RETRY);
    const latestLedger = await withRetry(() => rpc.getLatestLedger(), RETRY);

    const range = computeLedgerRange({
      lastProcessedLedger: checkpoint?.lastProcessedLedger ?? null,
      latestLedger,
      startLedger: checkpoint?.startLedger ?? config.startLedger,
      maxRange: config.maxLedgersPerRun,
    });

    if (range === null) {
      logger.info('Nothing to index', { latestLedger });
      return jsonResponse(
        {
          status: 'skipped',
          correlationId,
          checkpoint: checkpoint?.lastProcessedLedger,
          lag: ledgerLag(checkpoint, latestLedger),
        },
        200,
      );
    }

    logger.info('Indexing ledger range', {
      ledgerFrom: range.from,
      ledgerTo: range.to,
      truncated: range.truncated,
    });

    const events = await fetchRangeEvents(rpc, config, range.from, range.to);

    const ordered = [...events].sort(compareEventOrder);
    const unique = dedupeByIdentity(ordered, buildEventIdentity);

    await withRetry(() => db.upsertEvents(unique.map(toIndexedRow)), RETRY);

    // Advance only after the writes succeed, and only if it moves forward.
    if (canAdvanceCheckpoint(checkpoint, range.to)) {
      await withRetry(
        () =>
          db.advanceCheckpoint({
            lastProcessedLedger: range.to,
            startLedger: checkpoint?.startLedger ?? config.startLedger,
          }),
        RETRY,
      );
    }

    logger.info('Indexed ledger range', {
      eventsIndexed: unique.length,
      checkpoint: range.to,
    });

    return jsonResponse(
      {
        status: 'ok',
        correlationId,
        ledgerFrom: range.from,
        ledgerTo: range.to,
        eventsIndexed: unique.length,
        checkpoint: range.to,
        lag: Math.max(0, latestLedger - range.to),
      },
      200,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown indexing failure';
    logger.error('Indexing run failed', { reason });

    // Record the failure for operators. The checkpoint is deliberately left
    // untouched so the same range is retried on the next run.
    await db.recordRunFailure({
      correlationId,
      ledgerFrom: 0,
      ledgerTo: 0,
      reason,
    });

    return jsonResponse({ status: 'failed', correlationId, reason }, 500);
  }
}

// Supabase Edge Functions run this module as the request handler.
Deno.serve(handleRequest);
