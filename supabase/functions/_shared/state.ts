/**
 * Deriving a group's state from the facts the chain produced.
 *
 * Every figure here is a function of rows that were themselves written from
 * events. Nothing is accumulated: there is no running total that a replayed
 * range could add to twice, and no counter that a retry could inflate. Running
 * this over the same facts always produces the same answer, so a figure that has
 * drifted is corrected rather than compounded — which is what makes "the chain
 * wins and reconciliation repairs the index" a property of the code rather than
 * an intention.
 *
 * The consequence to keep in mind is that state is only as good as the facts.
 * If a fact is missing, this derives a smaller total from a smaller set; it
 * cannot know the difference. That is why the fact tables carry the chain's own
 * invariants as constraints, and why a missing event is a discovery problem to
 * be fixed at the source rather than something to compensate for here.
 */

export type GroupFacts = {
  members: readonly { readonly position: number }[];
  contributions: readonly { readonly round: number; readonly amount: string }[];
  payouts: readonly { readonly round: number; readonly recipient_amount: string }[];
  fees: readonly { readonly round: number; readonly fee: string }[];
  /** Whether the group's `start` event is on record. */
  started: boolean;
  /** Whether the group's `completed` event is on record. */
  completed: boolean;
  /** The highest ledger any of the group's events came from. */
  lastEventLedger: number;
};

/** Facts for a group with no recorded events yet. */
export const NO_FACTS: GroupFacts = {
  members: [],
  contributions: [],
  payouts: [],
  fees: [],
  started: false,
  completed: false,
  lastEventLedger: 0,
};

export type GroupStatus = 'open' | 'active' | 'completed';

export type GroupState = {
  contract_id: string;
  status: GroupStatus;
  member_count: number;
  /** Highest round any contribution or payout names; 0 before the first one. */
  current_round: number;
  /** Highest round that has paid out; 0 before the first payout. */
  completed_rounds: number;
  contributed_total: string;
  paid_out_total: string;
  fee_total: string;
  last_event_ledger: number;
};

/**
 * Sums base-unit amounts exactly.
 *
 * `BigInt`, not `Number`: an i128 amount can be 39 digits, and a double starts
 * losing integers past 2^53. A silently rounded total is worse than a failure,
 * because nothing downstream can tell it happened.
 *
 * The shape is checked first for the same reason. An amount that reaches here as
 * a JSON number has already been through a lossy conversion, and accepting it
 * would launder that into a plausible-looking total.
 */
export function sumAmounts(values: readonly string[]): string {
  let total = 0n;

  for (const value of values) {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      throw new Error(
        `amount is not a base-unit integer string: ${JSON.stringify(value)}. ` +
          `A numeric column read without a ::text cast arrives as a JSON number, ` +
          `which has already lost precision above 2^53.`,
      );
    }
    total += BigInt(value);
  }

  return total.toString();
}

function highestRound(rounds: readonly number[]): number {
  let highest = 0;
  for (const round of rounds) {
    if (round > highest) highest = round;
  }
  return highest;
}

export function deriveGroupState(contractId: string, facts: GroupFacts): GroupState {
  return {
    contract_id: contractId,

    // `completed` outranks `start`: a group that finished is completed whatever
    // else is on record.
    status: facts.completed ? 'completed' : facts.started ? 'active' : 'open',

    member_count: facts.members.length,

    // Rounds come from the events rather than from a counter, so a round is
    // "current" only because something named it.
    current_round: highestRound([
      ...facts.contributions.map((row) => row.round),
      ...facts.payouts.map((row) => row.round),
    ]),
    completed_rounds: highestRound(facts.payouts.map((row) => row.round)),

    contributed_total: sumAmounts(facts.contributions.map((row) => row.amount)),
    paid_out_total: sumAmounts(facts.payouts.map((row) => row.recipient_amount)),
    fee_total: sumAmounts(facts.fees.map((row) => row.fee)),

    last_event_ledger: facts.lastEventLedger,
  };
}

/** The derived columns, as they are stored. */
export type StoredGroupState = Omit<GroupState, 'contract_id'>;

/**
 * Reports where stored state disagrees with state derived from the facts.
 *
 * A row that has never been derived is not a divergence. Discovery writes a
 * group with placeholder figures, so the first derivation always differs from
 * them, and reporting that would drown the real signal. `last_event_ledger` is
 * the marker: zero means no derivation has run over this group yet.
 *
 * Returns human-readable descriptions so an operator reading a log learns what
 * changed and by how much.
 */
export function compareGroupState(
  stored: StoredGroupState | undefined,
  derived: GroupState,
): string[] {
  if (stored === undefined || stored.last_event_ledger === 0) return [];

  const differences: string[] = [];
  const note = (field: string, was: unknown, now: unknown): void => {
    differences.push(`${derived.contract_id}.${field}: ${String(was)} -> ${String(now)}`);
  };

  if (stored.status !== derived.status) note('status', stored.status, derived.status);
  if (stored.member_count !== derived.member_count) {
    note('member_count', stored.member_count, derived.member_count);
  }
  if (stored.current_round !== derived.current_round) {
    note('current_round', stored.current_round, derived.current_round);
  }
  if (stored.completed_rounds !== derived.completed_rounds) {
    note('completed_rounds', stored.completed_rounds, derived.completed_rounds);
  }

  // Compared as integers so that a formatting difference is not mistaken for a
  // difference in money.
  const money: ReadonlyArray<[keyof StoredGroupState, string]> = [
    ['contributed_total', derived.contributed_total],
    ['paid_out_total', derived.paid_out_total],
    ['fee_total', derived.fee_total],
  ];
  for (const [field, value] of money) {
    if (BigInt(String(stored[field])) !== BigInt(value)) note(field, stored[field], value);
  }

  return differences;
}
