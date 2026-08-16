/**
 * Soroban RPC client tests.
 *
 * These cover the two things the client must get right for the index to be
 * trustworthy: the identity it derives for each event, and whether it admits
 * events from calls that failed.
 */

import { assertEquals, assertRejects } from '@std/assert';
import {
  parseEventOrdinal,
  RpcError,
  SorobanRpcClient,
} from '../supabase/functions/_shared/stellar.ts';

Deno.test('parseEventOrdinal reads the ordinal from a real paging token', () => {
  // Tokens observed on Testnet.
  assertEquals(parseEventOrdinal('0019881652721336320-0000000000'), 0);
  assertEquals(parseEventOrdinal('0019881824520011776-0000000004'), 4);
  assertEquals(parseEventOrdinal('0000000000000000001-0000000123'), 123);
});

Deno.test('parseEventOrdinal uses the last separator', () => {
  assertEquals(parseEventOrdinal('a-b-0000000007'), 7);
});

Deno.test('parseEventOrdinal refuses tokens it does not understand', () => {
  // A guess here would produce identities that collide or drift, so every one
  // of these must be refused rather than approximated.
  for (const token of ['', '-', 'no-separator', 'token-', 'token-abc', 'token-1a', 'token- 1']) {
    assertEquals(parseEventOrdinal(token), undefined, `should refuse: ${JSON.stringify(token)}`);
  }
});

/** Runs `body` with `fetch` replaced, restoring it afterwards. */
async function withStubbedFetch(
  respond: (body: unknown) => unknown,
  body: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as unknown;
    return Promise.resolve(
      new Response(JSON.stringify(respond(request)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;

  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

function rpcResult(events: unknown[]): unknown {
  return { jsonrpc: '2.0', id: 1, result: { events, latestLedger: 100, cursor: 'c' } };
}

const FULL_EVENT = {
  type: 'contract',
  ledger: 42,
  contractId: 'CDXXET64G7U7RVB5ZAQIF5KWF64TO7INOMA5N4DVQUDWAFPQNVY5DC2O',
  id: '0019881824520011776-0000000003',
  transactionIndex: 7,
  txHash: 'de76970700000000000000000000000000000000000000000000000000000000ff',
  inSuccessfulContractCall: true,
  topic: ['AAAADwAAAARzdXN1'],
  value: 'AAAAEQAAAAEAAAABAAAADwAAAAhwb3NpdGlvbgAAAAMAAAAB',
};

Deno.test('getEvents derives the ledger-scoped ordinal, not the page position', async () => {
  await withStubbedFetch(
    () =>
      rpcResult([
        { ...FULL_EVENT, id: '0019881824520011776-0000000009' },
        { ...FULL_EVENT, id: '0019881824520011776-0000000002' },
      ]),
    async () => {
      const page = await new SorobanRpcClient('https://rpc.test').getEvents({
        kind: 'range',
        startLedger: 1,
        endLedger: 2,
        contractIds: ['CDXXET64G7U7RVB5ZAQIF5KWF64TO7INOMA5N4DVQUDWAFPQNVY5DC2O'],
      });

      // The first event sits at position 0 in the page but carries ordinal 9.
      // Reading the position instead would give it ordinal 0 and, on a later
      // page, a different one — indexing the same event twice.
      assertEquals(page.events.map((event) => event.eventIndex), [9, 2]);
    },
  );
});

Deno.test('getEvents records whether the emitting call succeeded', async () => {
  await withStubbedFetch(
    () =>
      rpcResult([
        { ...FULL_EVENT, id: '0019881824520011776-0000000001' },
        { ...FULL_EVENT, inSuccessfulContractCall: false, id: '0019881824520011776-0000000002' },
        {
          ...FULL_EVENT,
          inSuccessfulContractCall: undefined,
          id: '0019881824520011776-0000000003',
        },
      ]),
    async () => {
      const page = await new SorobanRpcClient('https://rpc.test').getEvents({
        kind: 'range',
        startLedger: 1,
        endLedger: 2,
        contractIds: ['CDXXET64G7U7RVB5ZAQIF5KWF64TO7INOMA5N4DVQUDWAFPQNVY5DC2O'],
      });

      // Absent is treated as not successful, so an event whose provenance we
      // cannot confirm is never indexed as money moving.
      assertEquals(page.events.map((event) => event.successful), [true, false, false]);
    },
  );
});

Deno.test('getEvents skips entries it cannot identify', async () => {
  await withStubbedFetch(
    () =>
      rpcResult([
        { ...FULL_EVENT, id: undefined },
        { ...FULL_EVENT, txHash: undefined },
        { ...FULL_EVENT, contractId: undefined },
        { ...FULL_EVENT, value: undefined },
        { ...FULL_EVENT, id: '0019881824520011776-0000000005' },
      ]),
    async () => {
      const page = await new SorobanRpcClient('https://rpc.test').getEvents({
        kind: 'range',
        startLedger: 1,
        endLedger: 2,
        contractIds: ['CDXXET64G7U7RVB5ZAQIF5KWF64TO7INOMA5N4DVQUDWAFPQNVY5DC2O'],
      });

      assertEquals(page.events.length, 1);
      assertEquals(page.events[0]?.eventIndex, 5);
    },
  );
});

Deno.test('getEvents fails loudly on a paging token it cannot parse', async () => {
  await withStubbedFetch(
    () => rpcResult([{ ...FULL_EVENT, id: 'opaque-token-without-ordinal' }]),
    async () => {
      // Skipping would lose the event permanently, because the checkpoint moves
      // past the ledger it came from. Failing keeps the range for a retry.
      await assertRejects(
        () =>
          new SorobanRpcClient('https://rpc.test').getEvents({
            kind: 'range',
            startLedger: 1,
            endLedger: 2,
            contractIds: ['CDXXET64G7U7RVB5ZAQIF5KWF64TO7INOMA5N4DVQUDWAFPQNVY5DC2O'],
          }),
        RpcError,
        'unparseable id',
      );
    },
  );
});
