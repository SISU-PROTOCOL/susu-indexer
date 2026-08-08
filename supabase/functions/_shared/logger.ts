/**
 * Structured logging.
 *
 * The indexer must never log secrets, keys, or full request headers. Logs are
 * JSON objects carrying a correlation id so a scheduled run can be traced.
 *
 * Redaction is defensive: callers should not pass secrets in the first place,
 * but a recursive pass means a nested mistake cannot leak a credential into log
 * storage.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Field names that must never appear in log output, at any depth. */
const FORBIDDEN_FIELD_PATTERN =
  /(secret|password|token|privatekey|private_key|service[_-]?role|apikey|api_key|authorization|cookie)/i;

/** Strings longer than this are truncated to bound log volume. */
const MAX_STRING_LENGTH = 512;

/**
 * Recursively removes sensitive fields from a log payload.
 *
 * Handles nested objects and arrays. Primitives are returned unchanged, so this
 * can be applied to any value without changing its type semantics.
 */
export function redact(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((item) => redact(item));
  }

  if (input !== null && typeof input === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      output[key] = FORBIDDEN_FIELD_PATTERN.test(key) ? '[redacted]' : redact(value);
    }
    return output;
  }

  if (typeof input === 'string' && input.length > MAX_STRING_LENGTH) {
    return `${input.slice(0, MAX_STRING_LENGTH)}…[truncated]`;
  }

  return input;
}

export type LogFields = Record<string, unknown>;

export type Logger = {
  debug: (message: string, fields?: LogFields) => void;
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
};

/** Creates a logger that writes redacted JSON lines to stdout/stderr. */
export function createLogger(correlationId: string): Logger {
  const emit = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      correlationId,
      message,
      ...(redact(fields) as Record<string, unknown>),
    });

    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}
