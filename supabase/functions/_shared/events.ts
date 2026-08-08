/**
 * Chain event identity, validation and ordering.
 *
 * The indexer ingests decoded chain events idempotently. Idempotency depends on
 * a deterministic identity for every event: the same on-chain event must always
 * produce the same key, so a retried, duplicated or overlapping run cannot
 * create duplicate rows or overwrite one event with another's data.
 *
 * Identity is `contractId:ledger:txHash:eventIndex`. The contract is included so
 * distinct contracts emitting events at the same ledger and index cannot collide,
 * `ledger` disambiguates reused transaction hashes, and `eventIndex`
 * disambiguates multiple events within one transaction.
 */

export type ChainEventKind =
  | 'group_created'
  | 'member_joined'
  | 'group_started'
  | 'contribution'
  | 'payout'
  | 'fee'
  | 'completed';

export const CHAIN_EVENT_KINDS: readonly ChainEventKind[] = [
  'group_created',
  'member_joined',
  'group_started',
  'contribution',
  'payout',
  'fee',
  'completed',
];

export type IndexableEvent = {
  kind: ChainEventKind;
  contractId: string;
  ledger: number;
  txHash: string;
  /** Index of the event within its transaction. */
  eventIndex: number;
  /** Index of the transaction within its ledger. */
  txIndex: number;
  /** Base-unit amount as a string. Present for contribution, payout, and fee. */
  amount?: string;
};

export type EventValidationResult =
  | { ok: true; event: IndexableEvent }
  | { ok: false; reason: string };

const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;
const TX_HASH_PATTERN = /^[0-9a-f]{64}$/;
const AMOUNT_KINDS: readonly ChainEventKind[] = ['contribution', 'payout', 'fee'];

/**
 * Builds the deterministic identity used for idempotent upserts.
 *
 * Must remain stable: changing this format would orphan previously indexed rows.
 */
export function buildEventIdentity(event: {
  contractId: string;
  ledger: number;
  txHash: string;
  eventIndex: number;
}): string {
  return `${event.contractId}:${event.ledger}:${event.txHash}:${event.eventIndex}`;
}

/**
 * Validates a decoded event before it can be persisted.
 *
 * Malformed events are rejected rather than coerced: a bad amount must never be
 * silently interpreted as a valid one, because the database is used for
 * reconciliation against chain state.
 */
export function validateEvent(input: IndexableEvent): EventValidationResult {
  if (!CHAIN_EVENT_KINDS.includes(input.kind)) {
    return { ok: false, reason: `unknown event kind: ${String(input.kind)}` };
  }

  if (!CONTRACT_ID_PATTERN.test(input.contractId)) {
    return { ok: false, reason: 'contractId is not a valid Soroban contract address' };
  }

  if (!Number.isSafeInteger(input.ledger) || input.ledger < 0) {
    return { ok: false, reason: 'ledger must be a non-negative safe integer' };
  }

  if (!TX_HASH_PATTERN.test(input.txHash)) {
    return { ok: false, reason: 'txHash must be 64 lowercase hex characters' };
  }

  if (!Number.isSafeInteger(input.txIndex) || input.txIndex < 0) {
    return { ok: false, reason: 'txIndex must be a non-negative safe integer' };
  }

  if (!Number.isSafeInteger(input.eventIndex) || input.eventIndex < 0) {
    return { ok: false, reason: 'eventIndex must be a non-negative safe integer' };
  }

  const requiresAmount = AMOUNT_KINDS.includes(input.kind);
  if (requiresAmount && input.amount === undefined) {
    return { ok: false, reason: `${input.kind} events must carry an amount` };
  }

  if (input.amount !== undefined && !/^\d+$/.test(input.amount)) {
    // Rejects negative, decimal, and floating-point representations.
    return { ok: false, reason: 'amount must be a non-negative integer string of base units' };
  }

  return { ok: true, event: input };
}

/**
 * Orders events deterministically so that replay produces a stable write order.
 *
 * Ledger first, then transaction index, then event index. The transaction hash
 * breaks ties so the order is total, not merely partial.
 */
export function compareEventOrder(
  a: Pick<IndexableEvent, 'ledger' | 'txIndex' | 'eventIndex' | 'txHash'>,
  b: Pick<IndexableEvent, 'ledger' | 'txIndex' | 'eventIndex' | 'txHash'>,
): number {
  if (a.ledger !== b.ledger) return a.ledger - b.ledger;
  if (a.txIndex !== b.txIndex) return a.txIndex - b.txIndex;
  if (a.eventIndex !== b.eventIndex) return a.eventIndex - b.eventIndex;
  return a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0;
}

/**
 * Removes duplicate identities while preserving first-seen order.
 *
 * RPC responses can legitimately repeat data across paginated calls; the
 * checkpoint may also overlap the previous run's range. Both cases must collapse
 * to a single write per event.
 */
export function dedupeByIdentity<T>(
  items: readonly T[],
  identityOf: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    const id = identityOf(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }

  return result;
}
