/**
 * Group state derivation tests.
 *
 * Two things are being proven here. That the arithmetic is exact — these are
 * money totals and a rounded one is indistinguishable from a correct one — and
 * that a group's state can be recovered from the recorded facts alone, which is
 * what lets reconciliation repair it instead of trusting it.
 */

import { assertEquals, assertThrows } from '@std/assert';
import type { DecodedChainEvent } from '../supabase/functions/_shared/decode.ts';
import {
  compareGroupState,
  deriveGroupState,
  type GroupFacts,
  NO_FACTS,
  sumAmounts,
} from '../supabase/functions/_shared/state.ts';
import { allEvents, decodeOk, GROUP_ID } from './fixture.ts';

const CONTRACT = `C${'B'.repeat(55)}`;

function facts(overrides: Partial<GroupFacts> = {}): GroupFacts {
  return { ...NO_FACTS, ...overrides };
}

/** Sums base-unit amounts the way the tests expect, without going via Number. */
function sum(values: readonly string[]): string {
  return values.reduce((total, value) => total + BigInt(value), 0n).toString();
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

Deno.test('sums amounts exactly, past what a double can hold', () => {
  // 2^127-1, the largest i128, twice over. A Number total here would be wrong
  // and nothing downstream would be able to tell.
  const largest = '170141183460469231731687303715884105727';
  assertEquals(sumAmounts([largest, largest]), '340282366920938463463374607431768211454');
});

Deno.test('sums an empty set to zero', () => {
  assertEquals(sumAmounts([]), '0');
});

Deno.test('refuses an amount that is not an integer string', () => {
  // A numeric column read without its ::text cast arrives as a JSON number, and
  // above 2^53 that number has already lost precision. Summing it would launder
  // the loss into a plausible total, so it is refused instead.
  for (const value of ['1.5', '-1', '1e7', '', ' 12 ', '0x10', '1_000']) {
    assertThrows(() => sumAmounts([value]), Error, 'not a base-unit integer string');
  }

  // The shape a lossy read would actually take.
  assertThrows(
    () => sumAmounts([1.7014118346046923e38 as unknown as string]),
    Error,
    'not a base-unit integer string',
  );
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

Deno.test('a group with no events is open and zeroed', () => {
  assertEquals(deriveGroupState(CONTRACT, NO_FACTS), {
    contract_id: CONTRACT,
    status: 'open',
    member_count: 0,
    current_round: 0,
    completed_rounds: 0,
    contributed_total: '0',
    paid_out_total: '0',
    fee_total: '0',
    last_event_ledger: 0,
  });
});

Deno.test('status follows the lifecycle events the chain emitted', () => {
  assertEquals(deriveGroupState(CONTRACT, facts()).status, 'open');
  assertEquals(deriveGroupState(CONTRACT, facts({ started: true })).status, 'active');
  assertEquals(
    deriveGroupState(CONTRACT, facts({ started: true, completed: true })).status,
    'completed',
  );
  // A completed group is completed whatever else is on record.
  assertEquals(deriveGroupState(CONTRACT, facts({ completed: true })).status, 'completed');
});

Deno.test('counts members from the recorded joins', () => {
  const state = deriveGroupState(
    CONTRACT,
    facts({
      members: [{ position: 1 }, { position: 2 }, { position: 3 }],
    }),
  );
  assertEquals(state.member_count, 3);
});

Deno.test('rounds come from the events that named them', () => {
  // A round is current because a contribution named it, and complete because a
  // payout did — not because a counter said so.
  const state = deriveGroupState(
    CONTRACT,
    facts({
      contributions: [{ round: 1, amount: '1' }, { round: 2, amount: '1' }],
      payouts: [{ round: 1, recipient_amount: '1' }],
    }),
  );

  assertEquals(state.current_round, 2);
  assertEquals(state.completed_rounds, 1);
});

Deno.test('totals are the sums of the recorded facts', () => {
  const state = deriveGroupState(
    CONTRACT,
    facts({
      contributions: [{ round: 1, amount: '100000000' }, { round: 1, amount: '50000000' }],
      payouts: [{ round: 1, recipient_amount: '149250000' }],
      fees: [{ round: 1, fee: '750000' }],
    }),
  );

  assertEquals(state.contributed_total, '150000000');
  assertEquals(state.paid_out_total, '149250000');
  assertEquals(state.fee_total, '750000');
});

Deno.test('deriving twice from the same facts gives the same state', () => {
  const once = deriveGroupState(
    CONTRACT,
    facts({
      started: true,
      members: [{ position: 1 }],
      contributions: [{ round: 1, amount: '100000000' }],
    }),
  );
  assertEquals(
    deriveGroupState(
      CONTRACT,
      facts({
        started: true,
        members: [{ position: 1 }],
        contributions: [{ round: 1, amount: '100000000' }],
      }),
    ),
    once,
  );
});

// ---------------------------------------------------------------------------
// Divergence
// ---------------------------------------------------------------------------

const DERIVED = deriveGroupState(CONTRACT, facts({ started: true }));

Deno.test('a group that has never been derived is not reported as divergent', () => {
  // Discovery writes placeholders, so the first derivation always differs from
  // them. Reporting that would bury the real signal in first-run noise.
  assertEquals(compareGroupState(undefined, DERIVED), []);
  assertEquals(
    compareGroupState({ ...DERIVED, status: 'open', last_event_ledger: 0 }, DERIVED),
    [],
  );
});

Deno.test('agreement between stored and derived state is silent', () => {
  const stored = { ...DERIVED };
  assertEquals(compareGroupState(stored, DERIVED), []);
});

Deno.test('a drifted total is reported', () => {
  const stored = { ...DERIVED, contributed_total: '999', last_event_ledger: 10 };
  const differences = compareGroupState(stored, DERIVED);

  assertEquals(differences.length, 1);
  assertEquals(differences[0]?.includes('contributed_total'), true);
});

Deno.test('every kind of drift is reported', () => {
  const stored = {
    ...DERIVED,
    status: 'completed' as const,
    member_count: 99,
    current_round: 99,
    completed_rounds: 99,
    contributed_total: '1',
    paid_out_total: '1',
    fee_total: '1',
    last_event_ledger: 10,
  };

  assertEquals(compareGroupState(stored, DERIVED).length, 7);
});

// ---------------------------------------------------------------------------
// Against real events
// ---------------------------------------------------------------------------

/** The facts for one group, read from the captured events. */
function factsFor(decoded: readonly DecodedChainEvent[], contractId: string): GroupFacts {
  const result: GroupFacts = {
    members: [],
    contributions: [],
    payouts: [],
    fees: [],
    started: false,
    completed: false,
    lastEventLedger: 0,
  };

  // A group's own events are emitted by the group; `group_created` comes from
  // the Factory and so is not among them.
  const members: { position: number }[] = [];
  const contributions: { round: number; amount: string }[] = [];
  const payouts: { round: number; recipient_amount: string }[] = [];
  const fees: { round: number; fee: string }[] = [];
  let started = false;
  let completed = false;
  let lastEventLedger = 0;

  for (const event of decoded) {
    if (event.contractId !== contractId) continue;
    if (event.ledger > lastEventLedger) lastEventLedger = event.ledger;

    switch (event.name) {
      case 'join':
        members.push({ position: event.position });
        break;
      case 'contribution':
        contributions.push({ round: event.round, amount: event.amount });
        break;
      case 'payout':
        payouts.push({ round: event.round, recipient_amount: event.recipientAmount });
        break;
      case 'fee':
        fees.push({ round: event.round, fee: event.fee });
        break;
      case 'start':
        started = true;
        break;
      case 'completed':
        completed = true;
        break;
      default:
        break;
    }
  }

  return { ...result, members, contributions, payouts, fees, started, completed, lastEventLedger };
}

const decoded = allEvents.map(decodeOk);
const realFacts = factsFor(decoded, GROUP_ID);
const realState = deriveGroupState(GROUP_ID, realFacts);

Deno.test('the captured group derives its whole lifecycle from its events', () => {
  assertEquals(realState.status, 'completed');
  assertEquals(realState.member_count, 3);
  assertEquals(realState.current_round, 3);
  assertEquals(realState.completed_rounds, 3);
  assertEquals(realState.last_event_ledger > 0, true);
});

Deno.test('the captured group takes in exactly what it paid out and charged', () => {
  // The invariant that matters, on real bytes: three rounds of three members at
  // 10 USDC each is 90 USDC in, and every unit of it leaves as a payout or a
  // fee. A decoder that dropped or duplicated one event would break this.
  assertEquals(realState.contributed_total, '900000000');
  assertEquals(realState.contributed_total, sum(realFacts.contributions.map((r) => r.amount)));
  assertEquals(
    BigInt(realState.paid_out_total) + BigInt(realState.fee_total),
    BigInt(realState.contributed_total),
  );
});

Deno.test('re-deriving the captured group agrees with itself', () => {
  assertEquals(deriveGroupState(GROUP_ID, realFacts), realState);
});
