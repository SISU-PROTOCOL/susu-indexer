/**
 * Index tables and checkpoint persistence.
 *
 * Uses the service-role key, which bypasses RLS. This code runs **only** in the
 * trusted indexer function: the key must never be shipped to a client, embedded
 * in a response, or written to a log.
 *
 * RLS remains enabled on these tables and grants browser roles no access, so a
 * leaked anon key cannot read or write index state. The service role is not a
 * substitute for those protections — it is an additional, server-only path.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Checkpoint } from './checkpoint.ts';
import type { NewGroup } from './discovery.ts';
import type { IngestPlan } from './ingest.ts';

export type IndexedEventRow = {
  /** Chain-derived identity; unique, so replays never duplicate rows. */
  event_identity: string;
  ledger: number;
  tx_hash: string;
  tx_index: number;
  event_index: number;
  contract_id: string;
  topic: string[];
  value: string;
};

export class IndexerDb {
  #client: SupabaseClient;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.#client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /**
   * Reads the stored checkpoint.
   *
   * Returns `undefined` when none exists, which means the indexer has not run
   * yet and should start from the configured deployment ledger.
   */
  async getCheckpoint(): Promise<Checkpoint | undefined> {
    const { data, error } = await this.#client
      .from('indexer_checkpoints')
      .select('last_processed_ledger, start_ledger, updated_at')
      .eq('id', 'default')
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to read indexer checkpoint: ${error.message}`);
    }
    if (!data) return undefined;

    return {
      lastProcessedLedger: Number(data.last_processed_ledger),
      startLedger: Number(data.start_ledger),
      updatedAt: String(data.updated_at),
    };
  }

  /**
   * Idempotently upserts indexed events.
   *
   * Conflicting on `event_identity` means a replay or an overlapping range, so
   * the existing row is left as-is rather than overwritten.
   */
  async upsertEvents(rows: readonly IndexedEventRow[]): Promise<void> {
    if (rows.length === 0) return;

    const { error } = await this.#client
      .from('indexed_events')
      .upsert([...rows], { onConflict: 'event_identity', ignoreDuplicates: true });

    if (error) {
      throw new Error(`Failed to upsert indexed events: ${error.message}`);
    }
  }

  /**
   * The group contracts the indexer already knows about.
   *
   * This is the watch list: a group's events are emitted by its own contract,
   * so without these the indexer would see only the Factory. The set grows with
   * every group deployed, which is fine at this scale and revisit-worthy beyond
   * it — the RPC takes the whole list as a filter on every page.
   */
  async listGroupContractIds(): Promise<string[]> {
    const { data, error } = await this.#client.from('groups').select('contract_id');

    if (error) {
      throw new Error(`Failed to read indexed group contracts: ${error.message}`);
    }

    return (data ?? []).map((row) => String(row.contract_id));
  }

  /**
   * Records groups the indexer has just discovered.
   *
   * Existing rows are left alone. Discovery supplies identity and nothing else,
   * and the columns it does not set — status, member count, totals — are derived
   * state that belongs to reconciliation, not to discovery.
   */
  async upsertGroups(rows: readonly NewGroup[]): Promise<void> {
    if (rows.length === 0) return;

    const { error } = await this.#client
      .from('groups')
      .upsert([...rows], { onConflict: 'contract_id', ignoreDuplicates: true });

    if (error) {
      throw new Error(`Failed to upsert groups: ${error.message}`);
    }
  }

  /**
   * Records a run's projected events.
   *
   * Groups must already be written: every fact table refers to a group row, and
   * in the range that discovers a group, the group and its facts arrive
   * together.
   *
   * Every write ignores rows that already exist. A replay, an overlapping range
   * and a retried failure therefore all do the same thing, so the index cannot
   * be corrupted by running the same ledger twice.
   */
  async persistPlan(plan: IngestPlan): Promise<void> {
    await this.#insertIgnoringDuplicates('decoded_events', plan.decoded, 'event_identity');
    await this.#insertIgnoringDuplicates('group_members', plan.members, 'contract_id,member');
    await this.#insertIgnoringDuplicates('contributions', plan.contributions, 'event_identity');
    await this.#insertIgnoringDuplicates('payouts', plan.payouts, 'event_identity');
    await this.#insertIgnoringDuplicates('protocol_fees', plan.fees, 'event_identity');
  }

  async #insertIgnoringDuplicates(
    table: string,
    rows: readonly object[],
    onConflict: string,
  ): Promise<void> {
    if (rows.length === 0) return;

    const { error } = await this.#client
      .from(table)
      .upsert([...rows], { onConflict, ignoreDuplicates: true });

    if (error) {
      throw new Error(`Failed to record ${table}: ${error.message}`);
    }
  }

  /**
   * Advances the checkpoint.
   *
   * Guards against regression in the database as well as in code: the update
   * only applies when the new ledger is strictly greater, so concurrent runs
   * cannot move the checkpoint backwards.
   */
  async advanceCheckpoint(params: {
    lastProcessedLedger: number;
    startLedger: number;
  }): Promise<void> {
    const { error } = await this.#client
      .from('indexer_checkpoints')
      .upsert(
        {
          id: 'default',
          last_processed_ledger: params.lastProcessedLedger,
          start_ledger: params.startLedger,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' },
      );

    if (error) {
      throw new Error(`Failed to advance indexer checkpoint: ${error.message}`);
    }
  }

  /** Records a failed run for operational visibility. Never throws. */
  async recordRunFailure(params: {
    correlationId: string;
    ledgerFrom: number;
    ledgerTo: number;
    reason: string;
  }): Promise<void> {
    const { error } = await this.#client.from('indexer_runs').insert({
      correlation_id: params.correlationId,
      ledger_from: params.ledgerFrom,
      ledger_to: params.ledgerTo,
      status: 'failed',
      // Truncated: error text can be long, and never contains secrets by construction.
      reason: params.reason.slice(0, 500),
    });

    if (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Failed to record indexer run failure',
          correlationId: params.correlationId,
        }),
      );
    }
  }
}
