/**
 * Chain event identity, ordering and deduplication.
 *
 * The indexer ingests chain events idempotently, and idempotency depends on a
 * deterministic identity for every event: the same on-chain event must always
 * produce the same key, so a retried, duplicated or overlapping run cannot
 * create duplicate rows or overwrite one event with another's data.
 *
 * Identity is `contractId:ledger:txHash:eventIndex`. The contract is included so
 * that distinct contracts emitting events at the same ledger and index cannot
 * collide, `ledger` disambiguates reused transaction hashes, and `eventIndex`
 * disambiguates several events within one transaction.
 *
 * What an event *means* — its name, its fields, which of them must be present —
 * belongs to `decode.ts`. This module deliberately keeps no vocabulary of its
 * own. It used to: a list of "kinds" naming `member_joined` and `group_started`,
 * which the contracts have never emitted, and which silently disagreed with the
 * decoder about what an event is called. A second list of names is a second
 * thing that has to be kept in step with the contracts, and it will not be.
 */

/** The coordinates that give an event its identity. */
export type EventIdentityParts = {
  contractId: string;
  ledger: number;
  txHash: string;
  /** Ledger-scoped event ordinal, from the RPC's paging token. */
  eventIndex: number;
};

/** The coordinates that order an event among its neighbours. */
export type EventOrderParts = EventIdentityParts & {
  /** Index of the transaction within its ledger. */
  txIndex: number;
};

/**
 * Builds the deterministic identity used for idempotent upserts.
 *
 * Must remain stable: changing this format would orphan every previously
 * indexed row, and the raw and derived layers are joined by it.
 */
export function buildEventIdentity(event: EventIdentityParts): string {
  return `${event.contractId}:${event.ledger}:${event.txHash}:${event.eventIndex}`;
}

/**
 * Orders events deterministically so that a replay writes them in the same
 * order the first run did.
 *
 * Ledger first, then transaction index, then event index. The transaction hash
 * breaks ties so the order is total rather than merely partial.
 */
export function compareEventOrder(a: EventOrderParts, b: EventOrderParts): number {
  if (a.ledger !== b.ledger) return a.ledger - b.ledger;
  if (a.txIndex !== b.txIndex) return a.txIndex - b.txIndex;
  if (a.eventIndex !== b.eventIndex) return a.eventIndex - b.eventIndex;
  return a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0;
}

/**
 * Removes duplicate identities while preserving first-seen order.
 *
 * RPC responses can legitimately repeat data across paginated calls, and a
 * checkpoint may overlap the previous run's range. Both cases must collapse to a
 * single write per event.
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
