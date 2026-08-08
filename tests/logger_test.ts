import { assertEquals, assertStringIncludes } from '@std/assert';
import { redact } from '../supabase/functions/_shared/logger.ts';

Deno.test('redact removes flat credential fields', () => {
  const result = redact({
    secret: 'super-secret-value',
    password: 'hunter2',
    token: 'abc',
    privateKey: 'SXXX',
    serviceRoleKey: 'sb_secret_xyz',
    apiKey: 'key',
    authorization: 'Bearer abc',
    cookie: 'session=1',
  }) as Record<string, unknown>;

  for (const value of Object.values(result)) {
    assertEquals(value, '[redacted]');
  }
});

Deno.test('redact removes snake_case credential variants', () => {
  const result = redact({
    private_key: 'SXXX',
    service_role_key: 'sb_secret_xyz',
    api_key: 'key',
  }) as Record<string, unknown>;

  for (const value of Object.values(result)) {
    assertEquals(value, '[redacted]');
  }
});

Deno.test('redact removes credentials nested in objects and arrays', () => {
  const output = redact({
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_value',
    nested: { authorization: 'Bearer abc', INDEXER_TASK_SECRET: 'shhh' },
    list: [{ password: 'hunter2' }],
    safe: 'keep-me',
  }) as Record<string, unknown>;

  const serialized = JSON.stringify(output);
  assertEquals(serialized.includes('sb_secret_value'), false);
  assertEquals(serialized.includes('Bearer abc'), false);
  assertEquals(serialized.includes('shhh'), false);
  assertEquals(serialized.includes('hunter2'), false);
  assertEquals(serialized.includes('keep-me'), true);
});

Deno.test('redact preserves non-sensitive operational fields', () => {
  const result = redact({
    ledgerFrom: 100,
    ledgerTo: 200,
    eventsIndexed: 5,
    correlationId: 'abc-123',
    contractId: 'CABC',
    truncated: false,
  }) as Record<string, unknown>;

  assertEquals(result['ledgerFrom'], 100);
  assertEquals(result['ledgerTo'], 200);
  assertEquals(result['eventsIndexed'], 5);
  assertEquals(result['correlationId'], 'abc-123');
  assertEquals(result['truncated'], false);
});

Deno.test('redact truncates very long strings', () => {
  const long = 'x'.repeat(1000);
  const result = redact({ reason: long }) as Record<string, unknown>;
  const value = String(result['reason']);
  assertStringIncludes(value, '[truncated]');
  assertEquals(value.length < long.length, true);
});

Deno.test('redact returns primitives unchanged', () => {
  assertEquals(redact(42), 42);
  assertEquals(redact('value'), 'value');
  assertEquals(redact(null), null);
  assertEquals(redact(true), true);
  assertEquals(redact(undefined), undefined);
});

Deno.test('redact handles an empty payload', () => {
  assertEquals(Object.keys(redact({}) as Record<string, unknown>).length, 0);
});
