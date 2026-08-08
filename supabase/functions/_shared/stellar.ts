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
  /** Index of the contract event within its transaction. */
  eventIndex: number;
  /** Contract that emitted the event. */
  contractId: string;
  /** Event topics, base64-encoded XDR, as returned by RPC. */
  topic: readonly string[];
  /** Event body, base64-encoded XDR. */
  value: string;
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
        eventIndex?: number;
        contractId?: string;
        topic?: string[];
        value?: string;
      }>;
      cursor?: string;
      latestLedger?: number;
    }>('getEvents', {
      startLedger: params.startLedger,
      endLedger: params.endLedger,
      filters: [{ type: 'contract', contractIds: params.contractIds }],
      pagination: { limit: params.limit ?? 100 },
    });

    const events: RpcEvent[] = (result.events ?? []).flatMap((event, index) => {
      // Skip malformed entries rather than indexing partial data; a missing
      // identity field would otherwise produce a colliding event identity.
      if (
        typeof event.ledger !== 'number' ||
        typeof event.txHash !== 'string' ||
        typeof event.contractId !== 'string' ||
        typeof event.value !== 'string'
      ) {
        return [];
      }

      return [{
        ledger: event.ledger,
        txHash: event.txHash,
        txIndex: event.transactionIndex ?? 0,
        eventIndex: event.eventIndex ?? index,
        contractId: event.contractId,
        topic: event.topic ?? [],
        value: event.value,
      }];
    });

    return {
      events,
      cursor: result.cursor,
      latestLedger: result.latestLedger ?? params.endLedger - 1,
    };
  }
}
