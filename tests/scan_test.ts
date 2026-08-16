/**
 * Ledger-range scanning tests.
 *
 * The property under test is that a range is read in full. Every failure here
 * is silent in production: the checkpoint advances past the range regardless,
 * so a dropped event is indistinguishable from an event that never existed.
 */

import { assertEquals, assertRejects } from '@std/assert';
import {
  type EventSource,
  fetchRangeEvents,
  PAGE_LIMIT,
} from '../supabase/functions/_shared/scan.ts';
import type {
  EventPageStart,
  GetEventsResult,
  RpcEvent,
} from '../supabase/functions/_shared/stellar.ts';

const CONTRACT = `C${'A'.repeat(55)}`;

function event(ledger: number, ordinal: number): RpcEvent {
  return {
    ledger,
    txHash: ordinal.toString(16).padStart(64, '0'),
    txIndex: 0,
    eventIndex: ordinal,
    id: `0000000000000000001-${String(ordinal).padStart(10, '0')}`,
    contractId: CONTRACT,
    topic: [],
    value: '',
    successful: true,
  };
}

/** `count` events, all in `ledger`. */
function eventsIn(ledger: number, count: number, offset = 0): RpcEvent[] {
  return Array.from({ length: count }, (_, i) => event(ledger, offset + i));
}

type Request = EventPageStart & { contractIds: string[]; limit?: number };

/**
 * An event source that returns pre-scripted pages in order.
 *
 * Records every request so tests can assert on the wire shape as well as the
 * result.
 */
function scriptedSource(
  pages: GetEventsResult[],
  requests: Request[] = [],
): EventSource & { requests: Request[] } {
  let index = 0;
  return {
    requests,
    getEvents(params: Request): Promise<GetEventsResult> {
      requests.push(params);
      const page = pages[index++];
      if (page === undefined) {
        throw new Error(`scripted source exhausted: request ${index} has no page`);
      }
      return Promise.resolve(page);
    },
  };
}

// ---------------------------------------------------------------------------
// Reading the range completely
// ---------------------------------------------------------------------------

Deno.test('returns the events from a single short page', async () => {
  const source = scriptedSource([
    { events: eventsIn(5, 3), cursor: 'c1', latestLedger: 10 },
  ]);
  const events = await fetchRangeEvents(source, [CONTRACT], 1, 10);
  assertEquals(events.length, 3);
  assertEquals(events.map((e) => e.ledger), [5, 5, 5]);
});

Deno.test('returns nothing when the range holds no events', async () => {
  const source = scriptedSource([{ events: [], cursor: 'c1', latestLedger: 10 }]);
  assertEquals(await fetchRangeEvents(source, [CONTRACT], 1, 10), []);
});

Deno.test('follows the cursor and returns every page', async () => {
  const source = scriptedSource([
    { events: eventsIn(1, PAGE_LIMIT, 0), cursor: 'c1', latestLedger: 10 },
    { events: eventsIn(2, PAGE_LIMIT, PAGE_LIMIT), cursor: 'c2', latestLedger: 10 },
    { events: eventsIn(3, 7, PAGE_LIMIT * 2), cursor: 'c3', latestLedger: 10 },
  ]);

  const events = await fetchRangeEvents(source, [CONTRACT], 1, 10);

  assertEquals(events.length, PAGE_LIMIT * 2 + 7);
  assertEquals(source.requests.length, 3);
});

Deno.test('reads a ledger whose events overflow one page', async () => {
  // The regression. A page filled entirely by ledger 5 leaves the rest of
  // ledger 5 still to read; advancing the next request's startLedger past 5 —
  // which the previous implementation did whenever a page stayed within one
  // ledger — drops those 50 events with no outward sign.
  const source = scriptedSource([
    { events: eventsIn(5, PAGE_LIMIT, 0), cursor: 'c1', latestLedger: 10 },
    { events: eventsIn(5, 50, PAGE_LIMIT), cursor: 'c2', latestLedger: 10 },
  ]);

  const events = await fetchRangeEvents(source, [CONTRACT], 5, 5);

  assertEquals(events.length, PAGE_LIMIT + 50);
  assertEquals(events.every((e) => e.ledger === 5), true);
});

Deno.test('keeps the events inside the range and stops at the first one past it', async () => {
  // A cursor page has no ledger bound, so the RPC is free to return events
  // beyond `to`. Those must not be recorded, and the scan must not continue.
  const source = scriptedSource([
    { events: eventsIn(5, PAGE_LIMIT, 0), cursor: 'c1', latestLedger: 10 },
    { events: [event(5, 100), event(6, 101), event(7, 102)], cursor: 'c2', latestLedger: 10 },
  ]);

  const events = await fetchRangeEvents(source, [CONTRACT], 5, 5);

  assertEquals(events.length, PAGE_LIMIT + 1);
  assertEquals(events.at(-1)?.ledger, 5);
});

// ---------------------------------------------------------------------------
// Refusing to return a partial range
// ---------------------------------------------------------------------------

Deno.test('fails when a full page arrives without a cursor', async () => {
  // Stopping here would silently truncate the range, and the checkpoint would
  // move past the unread events. Failing keeps the range for a retry instead.
  const source = scriptedSource([
    { events: eventsIn(5, PAGE_LIMIT, 0), latestLedger: 10 },
  ]);

  await assertRejects(
    () => fetchRangeEvents(source, [CONTRACT], 1, 10),
    Error,
    'cannot prove the range was read in full',
  );
});

Deno.test('fails when the cursor stops advancing', async () => {
  // A repeated cursor means the RPC is not making progress, and looping would
  // hang the run until the platform killed it.
  const source = scriptedSource([
    { events: eventsIn(1, PAGE_LIMIT, 0), cursor: 'stuck', latestLedger: 10 },
    { events: eventsIn(2, PAGE_LIMIT, PAGE_LIMIT), cursor: 'stuck', latestLedger: 10 },
  ]);

  await assertRejects(
    () => fetchRangeEvents(source, [CONTRACT], 1, 10),
    Error,
    'stopped advancing',
  );
});

Deno.test('rejects an inverted range rather than scanning nothing', async () => {
  const source = scriptedSource([]);
  await assertRejects(() => fetchRangeEvents(source, [CONTRACT], 10, 1), Error, 'invalid ledger');
  assertEquals(source.requests.length, 0);
});

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

Deno.test('asks for no contracts without calling the RPC', async () => {
  const source = scriptedSource([]);
  assertEquals(await fetchRangeEvents(source, [], 1, 10), []);
  assertEquals(source.requests.length, 0);
});

Deno.test('sends the ledger range once and a cursor thereafter', async () => {
  // The RPC rejects a request carrying both (`-32602: ledger ranges and cursor
  // cannot both be set`), so the two must never appear together.
  const source = scriptedSource([
    { events: eventsIn(1, PAGE_LIMIT, 0), cursor: 'c1', latestLedger: 10 },
    { events: eventsIn(2, 1, PAGE_LIMIT), cursor: 'c2', latestLedger: 10 },
  ]);

  await fetchRangeEvents(source, [CONTRACT], 10, 20);

  const [first, second] = source.requests;
  if (first?.kind !== 'range') throw new Error('the first request must carry the ledger range');
  if (second?.kind !== 'cursor') throw new Error('later requests must carry only a cursor');

  assertEquals(first.startLedger, 10);
  // `endLedger` is exclusive: the RPC returns nothing for endLedger N and an
  // event at N for endLedger N+1.
  assertEquals(first.endLedger, 21);
  assertEquals(first.limit, PAGE_LIMIT);

  // The rejected combination cannot even be expressed, which is the point of
  // splitting the two shapes rather than making both fields optional.
  assertEquals('startLedger' in second, false);
  assertEquals('endLedger' in second, false);
  assertEquals(second.cursor, 'c1');
});

Deno.test('carries the contract filter on every page', async () => {
  const source = scriptedSource([
    { events: eventsIn(1, PAGE_LIMIT, 0), cursor: 'c1', latestLedger: 10 },
    { events: eventsIn(2, 1, PAGE_LIMIT), cursor: 'c2', latestLedger: 10 },
  ]);

  await fetchRangeEvents(source, [CONTRACT], 1, 10);

  assertEquals(source.requests.every((r) => r.contractIds.length === 1), true);
  assertEquals(source.requests.every((r) => r.contractIds[0] === CONTRACT), true);
});
