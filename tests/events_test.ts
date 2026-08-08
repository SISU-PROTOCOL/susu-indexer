import { assertEquals, assertNotEquals } from '@std/assert';
import {
  buildEventIdentity,
  compareEventOrder,
  dedupeByIdentity,
  type IndexableEvent,
  validateEvent,
} from '../supabase/functions/_shared/events.ts';

const CONTRACT = `C${'A'.repeat(55)}`;
const OTHER_CONTRACT = `C${'B'.repeat(55)}`;
const TX_A = 'a'.repeat(64);
const TX_B = 'b'.repeat(64);

function event(overrides: Partial<IndexableEvent> = {}): IndexableEvent {
  return {
    kind: 'contribution',
    contractId: CONTRACT,
    ledger: 10,
    txHash: TX_A,
    txIndex: 0,
    eventIndex: 0,
    amount: '100000000',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

Deno.test('event identity is deterministic', () => {
  const reference = { contractId: CONTRACT, ledger: 42, txHash: TX_A, eventIndex: 3 };
  assertEquals(buildEventIdentity(reference), buildEventIdentity({ ...reference }));
  assertEquals(buildEventIdentity(reference), `${CONTRACT}:42:${TX_A}:3`);
});

Deno.test('event identity distinguishes contract, ledger, transaction and index', () => {
  const base = { contractId: CONTRACT, ledger: 1, txHash: TX_A, eventIndex: 0 };
  const identities = new Set([
    buildEventIdentity(base),
    buildEventIdentity({ ...base, contractId: OTHER_CONTRACT }),
    buildEventIdentity({ ...base, ledger: 2 }),
    buildEventIdentity({ ...base, txHash: TX_B }),
    buildEventIdentity({ ...base, eventIndex: 1 }),
  ]);
  assertEquals(identities.size, 5);
});

Deno.test('event identity does not collide across contracts at the same position', () => {
  assertNotEquals(
    buildEventIdentity({ contractId: CONTRACT, ledger: 5, txHash: TX_A, eventIndex: 0 }),
    buildEventIdentity({ contractId: OTHER_CONTRACT, ledger: 5, txHash: TX_A, eventIndex: 0 }),
  );
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

Deno.test('validateEvent accepts a well-formed contribution', () => {
  assertEquals(validateEvent(event()).ok, true);
});

Deno.test('validateEvent accepts a non-financial event without an amount', () => {
  assertEquals(validateEvent(event({ kind: 'group_created', amount: undefined })).ok, true);
});

Deno.test('validateEvent rejects an unknown event kind', () => {
  const result = validateEvent(event({ kind: 'not_a_kind' as IndexableEvent['kind'] }));
  assertEquals(result.ok, false);
});

Deno.test('validateEvent rejects a malformed contract id', () => {
  assertEquals(validateEvent(event({ contractId: 'not-a-contract' })).ok, false);
});

Deno.test('validateEvent rejects malformed transaction hashes', () => {
  for (const txHash of ['', 'zz', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    assertEquals(validateEvent(event({ txHash })).ok, false, `expected ${txHash} to be rejected`);
  }
});

Deno.test('validateEvent rejects negative ledger, txIndex and eventIndex', () => {
  assertEquals(validateEvent(event({ ledger: -1 })).ok, false);
  assertEquals(validateEvent(event({ txIndex: -1 })).ok, false);
  assertEquals(validateEvent(event({ eventIndex: -1 })).ok, false);
});

Deno.test('validateEvent requires amounts on financial events only', () => {
  for (const kind of ['contribution', 'payout', 'fee'] as const) {
    assertEquals(validateEvent(event({ kind, amount: undefined })).ok, false, kind);
  }
  for (const kind of ['group_created', 'member_joined', 'group_started', 'completed'] as const) {
    assertEquals(validateEvent(event({ kind, amount: undefined })).ok, true, kind);
  }
});

Deno.test('validateEvent rejects non-integer and negative amounts', () => {
  for (const amount of ['1.5', '-1', '1e7', 'abc', '', ' 12 ']) {
    assertEquals(validateEvent(event({ amount })).ok, false, `expected ${amount} to be rejected`);
  }
});

// ---------------------------------------------------------------------------
// Ordering and deduplication
// ---------------------------------------------------------------------------

Deno.test('compareEventOrder orders by ledger, then transaction, then event', () => {
  const earlier = event({ ledger: 1, txIndex: 0, eventIndex: 0 });
  const later = event({ ledger: 2, txIndex: 0, eventIndex: 0 });
  assertEquals(compareEventOrder(earlier, later) < 0, true);
  assertEquals(compareEventOrder(later, earlier) > 0, true);

  assertEquals(compareEventOrder(event({ txIndex: 0 }), event({ txIndex: 1 })) < 0, true);
  assertEquals(compareEventOrder(event({ eventIndex: 0 }), event({ eventIndex: 1 })) < 0, true);
});

Deno.test('compareEventOrder is a total order when only the hash differs', () => {
  const a = event({ txHash: TX_A });
  const b = event({ txHash: TX_B });
  assertEquals(compareEventOrder(a, b) < 0, true);
  assertEquals(compareEventOrder(b, a) > 0, true);
  assertEquals(compareEventOrder(a, a), 0);
});

Deno.test('dedupeByIdentity removes repeated identities but keeps distinct events', () => {
  const items = [
    event({ eventIndex: 0 }),
    event({ eventIndex: 0 }), // duplicate
    event({ eventIndex: 1 }),
    event({ eventIndex: 2 }),
  ];
  const result = dedupeByIdentity(items, buildEventIdentity);
  assertEquals(result.length, 3);
  assertEquals(result.map((item) => item.eventIndex), [0, 1, 2]);
});

Deno.test('dedupeByIdentity preserves first-seen order', () => {
  const items = [event({ ledger: 3 }), event({ ledger: 1 }), event({ ledger: 3 })];
  assertEquals(dedupeByIdentity(items, buildEventIdentity).map((item) => item.ledger), [3, 1]);
});

Deno.test('dedupeByIdentity handles an empty input', () => {
  assertEquals(dedupeByIdentity([], buildEventIdentity).length, 0);
});

Deno.test('dedupeByIdentity keeps events from different contracts distinct', () => {
  const items = [event({ contractId: CONTRACT }), event({ contractId: OTHER_CONTRACT })];
  assertEquals(dedupeByIdentity(items, buildEventIdentity).length, 2);
});
