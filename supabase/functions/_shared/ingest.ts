/**
 * Turning decoded events into the rows the application reads.
 *
 * `decoded_events` is the faithful record: every event the decoder understood,
 * with nothing added. The tables after it are projections of that record — the
 * same facts arranged for querying, with the invariants the chain enforces
 * restated as database constraints.
 *
 * Every function here is pure and every row carries the chain-derived event
 * identity as its key, so re-running a range inserts nothing new. That is what
 * makes a replay, an overlapping range and a retried failure all the same
 * operation: a set of inserts, most of which conflict with what is already
 * there and are ignored.
 *
 * Deliberately absent: any accumulation of state. A running total updated by
 * deltas would double-count the first time a range was replayed, and nothing
 * downstream could tell. State is recomputed from the recorded facts instead,
 * which is idempotent by construction.
 */

import { buildEventIdentity } from './events.ts';
import type { DecodedChainEvent } from './decode.ts';

/** A row for `decoded_events`: the event, its coordinates, and its payload. */
export type DecodedEventRow = {
  event_identity: string;
  name: string;
  contract_id: string;
  ledger: number;
  tx_hash: string;
  tx_index: number;
  event_index: number;
  event_id: string;
  payload: Record<string, unknown>;
};

export type GroupMemberRow = {
  contract_id: string;
  member: string;
  position: number;
  joined_ledger: number;
  event_identity: string;
};

export type ContributionRow = {
  event_identity: string;
  contract_id: string;
  member: string;
  round: number;
  amount: string;
  ledger: number;
  tx_hash: string;
};

export type PayoutRow = {
  event_identity: string;
  contract_id: string;
  recipient: string;
  round: number;
  /** Base units, net of the protocol fee. */
  recipient_amount: string;
  ledger: number;
  tx_hash: string;
};

export type ProtocolFeeRow = {
  event_identity: string;
  contract_id: string;
  treasury: string;
  round: number;
  fee: string;
  ledger: number;
  tx_hash: string;
};

export type IngestPlan = {
  decoded: DecodedEventRow[];
  members: GroupMemberRow[];
  contributions: ContributionRow[];
  payouts: PayoutRow[];
  fees: ProtocolFeeRow[];
  /**
   * Groups these events can change the derived state of.
   *
   * Not the same as "the contracts involved": `group_created` is emitted by the
   * Factory but describes a group, and the Factory's own configuration events
   * (`fee_updated`, `treasury_updated`, `pause_updated`) belong to no group and
   * are recorded without touching any.
   */
  touchedGroups: string[];
};

/** The event's own fields, without its coordinates. */
const COORDINATE_KEYS: readonly string[] = [
  'name',
  'contractId',
  'ledger',
  'txHash',
  'txIndex',
  'eventIndex',
  'eventId',
];

function payloadOf(event: DecodedChainEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (COORDINATE_KEYS.includes(key)) continue;
    payload[key] = value;
  }
  return payload;
}

/**
 * The group an event belongs to, or `undefined` for Factory-scoped events.
 *
 * A group's own events are emitted by the group's contract, except
 * `group_created`, which the Factory emits on the group's behalf — so the
 * interesting address is in the payload rather than in the emitting contract.
 */
function groupOf(event: DecodedChainEvent): string | undefined {
  switch (event.name) {
    case 'group_created':
      return event.group;
    case 'join':
    case 'start':
    case 'contribution':
    case 'payout':
    case 'fee':
    case 'completed':
      return event.contractId;
    case 'fee_updated':
    case 'treasury_updated':
    case 'pause_updated':
      return undefined;
  }
}

/**
 * Projects decoded events into rows for the chain-derived tables.
 *
 * Pure: the same events always produce the same plan, so this can be tested
 * without a database and re-run without a side effect.
 */
export function planIngest(events: readonly DecodedChainEvent[]): IngestPlan {
  const plan: IngestPlan = {
    decoded: [],
    members: [],
    contributions: [],
    payouts: [],
    fees: [],
    touchedGroups: [],
  };

  const touched = new Set<string>();

  for (const event of events) {
    const event_identity = buildEventIdentity(event);

    plan.decoded.push({
      event_identity,
      name: event.name,
      contract_id: event.contractId,
      ledger: event.ledger,
      tx_hash: event.txHash,
      tx_index: event.txIndex,
      event_index: event.eventIndex,
      event_id: event.eventId,
      payload: payloadOf(event),
    });

    const group = groupOf(event);
    if (group !== undefined) touched.add(group);

    switch (event.name) {
      case 'join':
        plan.members.push({
          contract_id: event.contractId,
          member: event.member,
          position: event.position,
          joined_ledger: event.ledger,
          event_identity,
        });
        break;

      case 'contribution':
        plan.contributions.push({
          event_identity,
          contract_id: event.contractId,
          member: event.member,
          round: event.round,
          amount: event.amount,
          ledger: event.ledger,
          tx_hash: event.txHash,
        });
        break;

      case 'payout':
        plan.payouts.push({
          event_identity,
          contract_id: event.contractId,
          recipient: event.recipient,
          round: event.round,
          recipient_amount: event.recipientAmount,
          ledger: event.ledger,
          tx_hash: event.txHash,
        });
        break;

      case 'fee':
        plan.fees.push({
          event_identity,
          contract_id: event.contractId,
          treasury: event.treasury,
          round: event.round,
          fee: event.fee,
          ledger: event.ledger,
          tx_hash: event.txHash,
        });
        break;

      // Recorded in `decoded_events` like every other event, but carrying no
      // fact of its own beyond the group it changed.
      case 'group_created':
      case 'start':
      case 'completed':
      case 'fee_updated':
      case 'treasury_updated':
      case 'pause_updated':
        break;
    }
  }

  plan.touchedGroups = [...touched];
  return plan;
}
