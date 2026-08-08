import { assertEquals } from '@std/assert';
import {
  BPS_DENOMINATOR,
  computeFee,
  computeRecipientAmount,
  parseStroops,
  USDC_DECIMALS,
  USDC_SCALE,
  verifyPayoutSplit,
} from '../supabase/functions/_shared/money.ts';

// ---------------------------------------------------------------------------
// Constants
//
// These mirror the contract's financial invariants. If a contract change alters
// them, this file must fail — that is the point.
// ---------------------------------------------------------------------------

Deno.test('USDC uses seven decimal places', () => {
  assertEquals(USDC_DECIMALS, 7);
  assertEquals(USDC_SCALE, 10_000_000n);
});

Deno.test('the basis-point denominator is 10_000', () => {
  assertEquals(BPS_DENOMINATOR, 10_000n);
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

Deno.test('parseStroops accepts non-negative integer strings', () => {
  assertEquals(parseStroops('300000000'), 300_000_000n);
  assertEquals(parseStroops('0'), 0n);
});

Deno.test('parseStroops rejects decimals, negatives, exponents and junk', () => {
  for (const bad of ['1.5', '-1', '1e7', '', 'abc', '1,000']) {
    let threw = false;
    try {
      parseStroops(bad);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `expected parseStroops(${bad}) to throw`);
  }
});

// ---------------------------------------------------------------------------
// Fee and recipient amounts
// ---------------------------------------------------------------------------

Deno.test('the canonical 3 x 10 USDC pool splits exactly', () => {
  // 3 members x 10 USDC = 30 USDC = 300_000_000 stroops.
  const pool = 300_000_000n;
  const fee = computeFee(pool, 50);
  const recipient = computeRecipientAmount(pool, 50);

  // 0.50% of 30 USDC is 0.15 USDC = 1_500_000 stroops.
  assertEquals(fee, 1_500_000n);
  // 99.50% is 29.85 USDC = 298_500_000 stroops.
  assertEquals(recipient, 298_500_000n);
  assertEquals(fee + recipient, pool);
});

Deno.test('a single 10 USDC contribution splits exactly', () => {
  const amount = 100_000_000n;
  assertEquals(computeFee(amount, 50), 500_000n);
  assertEquals(computeRecipientAmount(amount, 50), 99_500_000n);
});

Deno.test('fee truncates toward zero with no floating-point drift', () => {
  // 7 stroops at 50 bps is 0.035 stroops, which truncates to 0.
  assertEquals(computeFee(7n, 50), 0n);
  // 199 x 199 / 10000 = 3.9601 -> 3.
  assertEquals(computeFee(199n, 199), 3n);
});

Deno.test('fee and recipient always sum to the pool', () => {
  for (let amount = 0n; amount <= 10_000n; amount += 7n) {
    const fee = computeFee(amount, 50);
    const recipient = computeRecipientAmount(amount, 50);
    assertEquals(fee + recipient, amount, `split failed for ${amount}`);
  }
});

Deno.test('a zero pool yields a zero fee and zero recipient', () => {
  assertEquals(computeFee(0n, 50), 0n);
  assertEquals(computeRecipientAmount(0n, 50), 0n);
});

Deno.test('computeFee rejects invalid inputs', () => {
  for (const feeBps of [-1, 10_001, 1.5]) {
    let threw = false;
    try {
      computeFee(100n, feeBps);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `expected feeBps ${feeBps} to be rejected`);
  }

  let negativeThrew = false;
  try {
    computeFee(-1n, 50);
  } catch {
    negativeThrew = true;
  }
  assertEquals(negativeThrew, true, 'expected a negative amount to be rejected');
});

// ---------------------------------------------------------------------------
// Verification (used by reconciliation, never to decide a payout)
// ---------------------------------------------------------------------------

Deno.test('verifyPayoutSplit accepts a correct split', () => {
  assertEquals(verifyPayoutSplit(300_000_000n, 1_500_000n, 298_500_000n), []);
});

Deno.test('verifyPayoutSplit detects each class of divergence', () => {
  // Wrong fee (and correspondingly wrong recipient).
  assertEquals(verifyPayoutSplit(300_000_000n, 1_500_001n, 298_499_999n).length > 0, true);
  // Fee skimmed entirely to the recipient.
  assertEquals(verifyPayoutSplit(300_000_000n, 0n, 300_000_000n).length > 0, true);
  // Recipient short-changed.
  assertEquals(verifyPayoutSplit(300_000_000n, 1_500_000n, 297_000_000n).length > 0, true);
});

Deno.test('verifyPayoutSplit reports the sum invariant separately', () => {
  // A split that sums correctly but uses the wrong fee rate still fails.
  const discrepancies = verifyPayoutSplit(1_000n, 0n, 1_000n, 50);
  assertEquals(discrepancies.length > 0, true);
});
