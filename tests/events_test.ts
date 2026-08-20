import { assertEquals, assertNotEquals } from '@std/assert';
import {
  buildEventIdentity,
  compareEventOrder,
  dedupeByIdentity,
  type EventOrderParts,
} from '../supabase/functions/_shared/events.ts';

const CONTRACT = `C${'A'.repeat(55)}`;
const OTHER_CONTRACT = `C${'B'.repeat(55)}`;
const TX_A = 'a'.repeat(64);
const TX_B = 'b'.repeat(64);

function event(overrides: Partial<EventOrderParts> = {}): EventOrderParts {
  return {
    contractId: CONTRACT,
    ledger: 10,
    txHash: TX_A,
    txIndex: 0,
    eventIndex: 0,
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
