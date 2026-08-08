/**
 * Money arithmetic.
 *
 * Stellar assets use fixed-point integers (USDC has 7 decimal places), so every
 * amount in this codebase is a `bigint` of stroops. Floating point is never used
 * for money — `number` cannot represent these values exactly and errors would
 * compound across rounds.
 *
 * This module performs arithmetic for *verification and reconciliation only*. The
 * indexer holds no financial authority: it never decides an amount, recipient, or
 * eligibility. Contracts are the sole authority.
 */

/** Decimal places used by USDC on Stellar. */
export const USDC_DECIMALS = 7;

/** Scale factor: 1 USDC === 10_000_000 stroops. */
export const USDC_SCALE = 10n ** BigInt(USDC_DECIMALS);

/** Basis-point denominator. */
export const BPS_DENOMINATOR = 10_000n;

/**
 * Parses a base-unit amount string into `bigint` stroops.
 *
 * Rejects anything that is not a non-negative integer string. Deliberately does
 * not accept decimals or exponents, so a malformed or floating-point value from an
 * event can never be silently coerced into money.
 */
export function parseStroops(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('Amount must be a non-negative integer string of base units');
  }
  return BigInt(trimmed);
}

/**
 * Computes the protocol fee for a pool amount.
 *
 * `fee = amount * fee_bps / 10_000`, truncated by integer division, matching the
 * contract. The MVP fee is 50 bps (0.50%).
 */
export function computeFee(amount: bigint, feeBps = 50): bigint {
  if (amount < 0n) throw new Error('Amount must not be negative');
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new Error('Fee basis points must be an integer between 0 and 10000');
  }
  return (amount * BigInt(feeBps)) / BPS_DENOMINATOR;
}

/**
 * Computes the recipient amount for a pool.
 *
 * `recipient_amount = amount - fee`, so fee + recipient always equals the pool
 * exactly, with no rounding remainder left behind.
 */
export function computeRecipientAmount(amount: bigint, feeBps = 50): bigint {
  return amount - computeFee(amount, feeBps);
}

/**
 * Verifies that a payout splits a pool exactly into fee and recipient amounts.
 *
 * Returns a list of human-readable discrepancies; an empty list means the split
 * is consistent. Used by reconciliation to detect divergence between database
 * state and chain state, never to decide a payout.
 */
export function verifyPayoutSplit(
  pool: bigint,
  fee: bigint,
  recipient: bigint,
  feeBps = 50,
): string[] {
  const discrepancies: string[] = [];
  const expectedFee = computeFee(pool, feeBps);
  const expectedRecipient = computeRecipientAmount(pool, feeBps);

  if (fee !== expectedFee) {
    discrepancies.push(`fee mismatch: expected ${expectedFee} but observed ${fee}`);
  }
  if (recipient !== expectedRecipient) {
    discrepancies.push(
      `recipient mismatch: expected ${expectedRecipient} but observed ${recipient}`,
    );
  }
  if (fee + recipient !== pool) {
    discrepancies.push(`split does not sum to pool: ${fee} + ${recipient} !== ${pool}`);
  }

  return discrepancies;
}
