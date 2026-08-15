/**
 * Soroban RPC access.
 *
 * Read-only by design. The indexer never builds, signs, or submits
 * transactions: it observes chain state and records it. Financial authority
 * stays in the contracts.
 */

export type RpcEvent = {
  /** Ledger the event was emitted in. */
  ledger: number;
  /** Transaction hash containing the event. */
  txHash: string;
  /** Index of the transaction within its ledger. */
  txIndex: number;
  /**
   * Ledger-scoped ordinal of this event, taken from the RPC's paging token.
   *
   * The RPC does **not** return a per-transaction event index: it returns `id`,
   * a token of the form `<ledger-token>-<ordinal>`, where the ordinal counts
   * events across the whole ledger. Deriving this from the position of an event
   * within a response page instead — which is easy to do by accident, since
   * that is what an untouched `?? index` fallback does — produces an identity
   * that changes with pagination, so the same event gets indexed twice.
   */
  eventIndex: number;
  /** The RPC's own paging token for this event. Unique and stable. */
  id: string;
  /** Contract that emitted the event. */
  contractId: string;
  /** Event topics, base64-encoded XDR, as returned by RPC. */
  topic: readonly string[];
  /** Event body, base64-encoded XDR. */
  value: string;
  /**
   * Whether the call that emitted this event succeeded.
   *
   * Events are emitted during failed calls too. Indexing one would record a
   * contribution or a payout that never happened, so callers must only index
   * events where this is true.
   */
  successful: boolean;
};

export type GetEventsResult = {
  events: RpcEvent[];
  /** Ledger at which the RPC stopped returning data, if the response was truncated. */
  cursor?: string;
  latestLedger: number;
};

export class RpcError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

type JsonRpcResponse<T> = {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
};

/**
 * Minimal Soroban RPC client.
 *
 * Only the read methods the indexer needs are implemented — keeping the surface
 * small makes it auditable and avoids any accidental write capability.
 */
export class SorobanRpcClient {
  #url: string;
  #requestId = 0;

  constructor(url: string) {
    this.#url = url;
  }

  async #call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: ++this.#requestId,
      method,
      params,
    });

    const response = await fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    if (!response.ok) {
      throw new RpcError(`RPC request failed with status ${response.status}`, response.status);
    }

    const payload = (await response.json()) as JsonRpcResponse<T>;

    if (payload.error) {
      throw new RpcError(`RPC error ${payload.error.code}: ${payload.error.message}`);
    }

    if (payload.result === undefined) {
      throw new RpcError('RPC returned no result');
    }

    return payload.result;
  }

  /** Returns the network's current ledger sequence number. */
  async getLatestLedger(): Promise<number> {
    const result = await this.#call<{ sequence: number }>('getLatestLedger', {});
    return result.sequence;
  }

  /**
   * Fetches contract events in a ledger range.
   *
   * `startLedger` is inclusive and `endLedger` is exclusive, matching the RPC's
   * contract. The caller is responsible for bounding the range to stay within
   * the RPC's own limits.
   */
  async getEvents(params: {
    startLedger: number;
    endLedger: number;
    contractIds: string[];
    limit?: number;
  }): Promise<GetEventsResult> {
    const result = await this.#call<{
      events?: Array<{
        ledger?: number;
        txHash?: string;
        transactionIndex?: number;
        contractId?: string;
        id?: string;
        topic?: string[];
        value?: string;
        inSuccessfulContractCall?: boolean;
      }>;
      cursor?: string;
      latestLedger?: number;
    }>('getEvents', {
      startLedger: params.startLedger,
      endLedger: params.endLedger,
      filters: [{ type: 'contract', contractIds: params.contractIds }],
      pagination: { limit: params.limit ?? 100 },
    });

    const events: RpcEvent[] = [];

    for (const event of result.events ?? []) {
      // Skip malformed entries rather than indexing partial data; a missing
      // identity field would otherwise produce a colliding event identity.
      if (
        typeof event.ledger !== 'number' ||
        typeof event.txHash !== 'string' ||
        typeof event.contractId !== 'string' ||
        typeof event.value !== 'string' ||
        typeof event.id !== 'string'
      ) {
        continue;
      }

      // Without a parseable ordinal this event cannot be given a stable
      // identity. Skipping it would lose it permanently, because the checkpoint
      // advances past the ledger it came from; so the run fails instead and the
      // range is retried.
      const eventIndex = parseEventOrdinal(event.id);
      if (eventIndex === undefined) {
        throw new RpcError(`RPC returned an event with an unparseable id: ${event.id}`);
      }

      events.push({
        ledger: event.ledger,
        txHash: event.txHash,
        txIndex: event.transactionIndex ?? 0,
        eventIndex,
        id: event.id,
        contractId: event.contractId,
        topic: event.topic ?? [],
        value: event.value,
        successful: event.inSuccessfulContractCall === true,
      });
    }

    return {
      events,
      cursor: result.cursor,
      latestLedger: result.latestLedger ?? params.endLedger - 1,
    };
  }
}

/**
 * Extracts the ledger-scoped event ordinal from an RPC paging token.
 *
 * Tokens look like `0019881824520011776-0000000004`: a ledger token, a hyphen,
 * then the ordinal. Only the ordinal is used, and it must be a plain integer —
 * a token in any other shape means we do not understand the RPC's identity
 * scheme, and guessing at it would produce identities that collide or drift.
 */
export function parseEventOrdinal(id: string): number | undefined {
  const separator = id.lastIndexOf('-');
  if (separator <= 0 || separator === id.length - 1) return undefined;

  const ordinal = id.slice(separator + 1);
  if (!/^\d+$/.test(ordinal)) return undefined;

  const value = Number.parseInt(ordinal, 10);
  return Number.isSafeInteger(value) ? value : undefined;
}
