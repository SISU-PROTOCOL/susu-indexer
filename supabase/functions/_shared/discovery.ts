/**
 * Finding the group contracts the indexer must watch.
 *
 * The Factory deploys each group as its own contract, so a group's events are
 * emitted by an address nobody knows in advance. The only place that address
 * appears is the Factory's `group_created` event, which makes discovery a
 * prerequisite for reading anything a group does.
 *
 * The consequence is sharper than it first looks. A group is typically created
 * and used inside the same ledger range — created, joined, contributed to,
 * paid out — and the checkpoint moves past that range when the run finishes.
 * Registering a new group and waiting for the *next* run to read its events
 * would therefore skip them permanently: the next run begins after the ledgers
 * those events are in. So the caller must re-scan the range it just read for
 * the contracts discovered in it, and this module only answers which contracts
 * those are.
 *
 * One re-scan is enough. Only the Factory emits `group_created`, and the
 * re-scan watches group contracts alone, so it cannot discover anything further.
 */

import type { DecodedChainEvent } from './decode.ts';

/** A group the indexer has just learned about, ready to be recorded. */
export type NewGroup = {
  /** The group's own contract address; its primary identity. */
  contract_id: string;
  /** The Factory that deployed it. */
  factory_contract_id: string;
  /** The Factory's sequential id for this group. */
  group_id: number;
  creator: string;
  /** The SAC the group settles in. */
  token: string;
  /**
   * Contribution size in base units, as a string.
   *
   * It comes from an `i128` and can be 39 digits, which a JSON number cannot
   * hold. Passing it through as a string keeps Postgres casting it to numeric
   * without a round trip through floating point.
   */
  contribution_amount: string;
  member_capacity: number;
  created_ledger: number;
};

/**
 * Extracts the groups described by `group_created` events that are not already
 * watched.
 *
 * `alreadyWatched` is what stops the re-scan from being triggered by groups the
 * indexer already knows about, including the Factory and the token contract,
 * which are never groups and must not be watched as if they were.
 */
export function discoverGroups(
  events: readonly DecodedChainEvent[],
  alreadyWatched: readonly string[],
): NewGroup[] {
  const watched = new Set(alreadyWatched);
  const found = new Map<string, NewGroup>();

  for (const event of events) {
    if (event.name !== 'group_created') continue;

    // First sighting wins. The Factory emits this once per group, but a
    // replayed range can deliver it twice, and both copies describe the same
    // group — there is nothing in the second that supersedes the first.
    if (watched.has(event.group) || found.has(event.group)) continue;

    found.set(event.group, {
      contract_id: event.group,
      factory_contract_id: event.contractId,
      group_id: event.groupId,
      creator: event.creator,
      token: event.token,
      contribution_amount: event.contributionAmount,
      member_capacity: event.memberCapacity,
      created_ledger: event.ledger,
    });
  }

  return [...found.values()];
}
