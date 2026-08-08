import { assertEquals } from '@std/assert';
import {
  authorizeInvocation,
  constantTimeEqual,
  TASK_SECRET_HEADER,
} from '../supabase/functions/_shared/auth.ts';

const SECRET = 'a'.repeat(48);

function headersWith(secret?: string): Headers {
  const headers = new Headers();
  if (secret !== undefined) headers.set(TASK_SECRET_HEADER, secret);
  return headers;
}

Deno.test('constantTimeEqual returns true for identical strings', () => {
  assertEquals(constantTimeEqual('abc123', 'abc123'), true);
});

Deno.test('constantTimeEqual returns false for different strings of equal length', () => {
  assertEquals(constantTimeEqual('abc123', 'abc124'), false);
});

Deno.test('constantTimeEqual returns false for different lengths', () => {
  assertEquals(constantTimeEqual('abc', 'abcd'), false);
  assertEquals(constantTimeEqual('', 'a'), false);
});

Deno.test('constantTimeEqual treats empty strings as equal', () => {
  assertEquals(constantTimeEqual('', ''), true);
});

Deno.test('authorizes a correct secret', () => {
  assertEquals(authorizeInvocation(headersWith(SECRET), SECRET), { authorized: true });
});

Deno.test('rejects a request with no secret header', () => {
  assertEquals(authorizeInvocation(new Headers(), SECRET), {
    authorized: false,
    reason: 'missing_header',
  });
});

Deno.test('rejects an empty secret header', () => {
  assertEquals(authorizeInvocation(headersWith(''), SECRET), {
    authorized: false,
    reason: 'missing_header',
  });
});

Deno.test('rejects an incorrect secret', () => {
  assertEquals(authorizeInvocation(headersWith('b'.repeat(48)), SECRET), {
    authorized: false,
    reason: 'invalid_secret',
  });
});

Deno.test('rejects a secret that is a prefix of the expected value', () => {
  assertEquals(authorizeInvocation(headersWith(SECRET.slice(0, 47)), SECRET), {
    authorized: false,
    reason: 'invalid_secret',
  });
});

Deno.test('fails closed when the expected secret is not configured', () => {
  assertEquals(authorizeInvocation(headersWith(SECRET), undefined), {
    authorized: false,
    reason: 'not_configured',
  });
  assertEquals(authorizeInvocation(headersWith(SECRET), ''), {
    authorized: false,
    reason: 'not_configured',
  });
});
