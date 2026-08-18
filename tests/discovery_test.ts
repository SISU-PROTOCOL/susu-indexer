/**
 * Group discovery tests.
 *
 * Discovery decides what the indexer watches, and what it does not watch it
 * never sees. A group missed here is not merely delayed: the checkpoint moves
 * past the ledgers it was used in, so its whole history is absent from the index
 * with nothing to indicate a gap.
 */

import { assertEquals } from '@std/assert';
import type { DecodedChainEvent } from '../supabase/functions/_shared/decode.ts';
import { discoverGroups } from '../supabase/functions/_shared/discovery.ts';

const FACTORY = `C${'A'.repeat(55)}`;
const GROUP = `C${'B'.repeat(55)}`;
const OTHER_GROUP = `C${'C'.repeat(55)}`;
const TOKEN = `C${'E'.repeat(55)}`;
const CREATOR = `G${'D'.repeat(55)}`;
const TX = 'a'.repeat(64);

function groupCreated(
  overrides: { group?: string; ledger?: number; groupId?: number; contributionAmount?: string } =
    {},
): DecodedChainEvent {
  return {
    name: 'group_created',
    contractId: FACTORY,
    ledger: overrides.ledger ?? 100,
    txHash: TX,
    txIndex: 0,
    eventId: '0000000000000000001-0000000000',
    creator: CREATOR,
    group: overrides.group ?? GROUP,
    groupId: overrides.groupId ?? 1,
    token: TOKEN,
    contributionAmount: overrides.contributionAmount ?? '10000000',
    memberCapacity: 3,
  };
}

/** An event that is not `group_created`, to prove it is ignored. */
function join(ledger = 101): DecodedChainEvent {
  return {
    name: 'join',
    contractId: GROUP,
    ledger,
    txHash: TX,
    txIndex: 0,
    eventId: `0000000000000000001-${String(ledger).padStart(10, '0')}`,
    member: CREATOR,
    position: 1,
  };
}

Deno.test('discovers a group from the factory event that announced it', () => {
  const groups = discoverGroups([groupCreated()], [FACTORY]);

  assertEquals(groups.length, 1);
  assertEquals(groups[0], {
    contract_id: GROUP,
    factory_contract_id: FACTORY,
    group_id: 1,
    creator: CREATOR,
    token: TOKEN,
    contribution_amount: '10000000',
    member_capacity: 3,
    created_ledger: 100,
  });
});

Deno.test('keeps the contribution amount as a base-unit string', () => {
  // The value is an i128 and can be 39 digits, which a JSON number cannot hold.
  const amount = '170141183460469231731687303715884105727';
  const groups = discoverGroups([groupCreated({ contributionAmount: amount })], [FACTORY]);

  assertEquals(groups[0]?.contribution_amount, amount);
  assertEquals(typeof groups[0]?.contribution_amount, 'string');
});

Deno.test('returns nothing when there is nothing new', () => {
  assertEquals(discoverGroups([], [FACTORY]), []);
  assertEquals(discoverGroups([join()], [FACTORY]), []);
});

Deno.test('does not rediscover a group that is already watched', () => {
  // This is what keeps an every-run re-scan from happening: known groups must
  // not look new, or every range would trigger a second read of itself.
  assertEquals(discoverGroups([groupCreated()], [FACTORY, GROUP]), []);
});

Deno.test('never treats the factory or the token as a group', () => {
  // They are watched already, so they are in the exclude list. Discovery must
  // not resurrect them as groups and start reading their events twice.
  const events = [groupCreated({ group: FACTORY }), groupCreated({ group: TOKEN })];
  assertEquals(discoverGroups(events, [FACTORY, TOKEN]), []);
});

Deno.test('discovers several groups in one range', () => {
  const events = [
    groupCreated({ group: GROUP, groupId: 1 }),
    groupCreated({ group: OTHER_GROUP, groupId: 2, ledger: 105 }),
  ];

  const groups = discoverGroups(events, [FACTORY]);

  assertEquals(groups.map((group) => group.contract_id), [GROUP, OTHER_GROUP]);
  assertEquals(groups.map((group) => group.group_id), [1, 2]);
});

Deno.test('collapses a replayed announcement, keeping the first', () => {
  // A replayed range delivers the same event twice. Both copies describe the
  // same group and neither supersedes the other, so the count must stay at one
  // rather than the second silently overwriting the first.
  const events = [
    groupCreated({ groupId: 1, ledger: 100 }),
    groupCreated({ groupId: 1, ledger: 100 }),
  ];

  const groups = discoverGroups(events, [FACTORY]);

  assertEquals(groups.length, 1);
  assertEquals(groups[0]?.created_ledger, 100);
});

Deno.test('discovers a new group even when other events are present', () => {
  const events = [join(101), groupCreated(), join(102)];
  const groups = discoverGroups(events, [FACTORY]);
  assertEquals(groups.map((group) => group.contract_id), [GROUP]);
});
