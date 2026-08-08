/**
 * Invocation authorisation for the indexer function.
 *
 * The indexer must not be publicly triggerable: an unauthenticated caller could
 * burn through RPC quota, force expensive reindexing, or spam the database. It
 * is invoked on a schedule by Supabase Cron (or manually by an operator), and
 * every invocation must present a shared secret.
 *
 * This is deliberately **not** the service-role key: a key that grants database
 * superuser access must never be used as a network credential that has to be
 * transmitted and compared on every request.
 */

/** Header carrying the shared indexer secret. */
export const TASK_SECRET_HEADER = 'x-indexer-task-secret';

/**
 * Compares two strings in constant time.
 *
 * Prevents leaking secret length or content through response timing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  // Compare lengths without early return to avoid a length oracle.
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);

  let mismatch = aBytes.length ^ bBytes.length;
  const max = Math.max(aBytes.length, bBytes.length);

  for (let i = 0; i < max; i++) {
    const x = i < aBytes.length ? (aBytes[i] as number) : 0;
    const y = i < bBytes.length ? (bBytes[i] as number) : 0;
    mismatch |= x ^ y;
  }

  return mismatch === 0;
}

export type AuthResult =
  | { authorized: true }
  | { authorized: false; reason: 'missing_header' | 'invalid_secret' | 'not_configured' };

/**
 * Authorises an invocation from its request headers.
 *
 * Fails closed: a missing or unconfigured secret is never treated as authorised.
 */
export function authorizeInvocation(
  headers: Headers,
  expectedSecret: string | undefined,
): AuthResult {
  if (expectedSecret === undefined || expectedSecret.length === 0) {
    return { authorized: false, reason: 'not_configured' };
  }

  const provided = headers.get(TASK_SECRET_HEADER);
  if (provided === null || provided.length === 0) {
    return { authorized: false, reason: 'missing_header' };
  }

  if (!constantTimeEqual(provided, expectedSecret)) {
    return { authorized: false, reason: 'invalid_secret' };
  }

  return { authorized: true };
}
