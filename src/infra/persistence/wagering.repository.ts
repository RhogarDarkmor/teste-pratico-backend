import type { EntityManager } from '@mikro-orm/postgresql';
import type { IntegrationEvent } from '../../domain/events/integration-event';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { Money } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wagering/failure-code';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';

// o driver devolve timestamptz como texto, então normalizo para ISO na própria consulta
const ts = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const cursorTs = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const TX_COLUMNS = `
  id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
  kind, amount::text as amount, currency, reference_external_transaction_id, reference_transaction_id, status,
  failure_code, ${ts('created_at')} as created_at, ${ts('processed_at')} as processed_at,
  observed_balance::text as observed_balance`;

export interface StoredTransaction {
  transaction: WagerTransaction;
  observedBalance: Money | undefined;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  hasMore: boolean;
  nextCursorPosition?: { createdAt: string; id: string };
}

export class WageringRepository {
  constructor(private readonly em: Pick<EntityManager, 'execute'>) {}

  async findWallet(walletId: string): Promise<Wallet | undefined> {
    const rows = await this.em.execute(
      `select id, player_id, currency, balance::text as balance, version,
              ${ts('created_at')} as created_at, ${ts('updated_at')} as updated_at
         from wallets where id = ?`,
      [walletId],
    );
    return rows[0] ? this.toWallet(rows[0]) : undefined;
  }

  async lockWallet(walletId: string): Promise<Wallet | undefined> {
    const rows = await this.em.execute(
      `select id, player_id, currency, balance::text as balance, version,
              ${ts('created_at')} as created_at, ${ts('updated_at')} as updated_at
         from wallets where id = ? for update`,
      [walletId],
    );
    return rows[0] ? this.toWallet(rows[0]) : undefined;
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    await this.em.execute(
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.toString(),
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
    );
  }

  async updateWalletBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const result = (await this.em.execute(
      `update wallets set balance = ?, version = ?, updated_at = ? where id = ? and version = ?`,
      [wallet.balance.toString(), wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
      'run',
    )) as unknown as { affectedRows: number };
    if (result.affectedRows !== 1) {
      throw new Error(`Wallet ${wallet.id} changed concurrently (expected version ${expectedVersion})`);
    }
  }

  async findByIdempotency(
    idempotencyKey: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredTransaction[]> {
    const rows = await this.em.execute(
      `select ${TX_COLUMNS} from wager_transactions
        where idempotency_key = ? or (provider_id = ? and external_transaction_id = ?)`,
      [idempotencyKey, providerId, externalTransactionId],
    );
    return rows.map((row) => this.toStored(row));
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const rows = await this.em.execute(
      `select ${TX_COLUMNS} from wager_transactions where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    return rows[0] ? this.toStored(rows[0]).transaction : undefined;
  }

  async findTransaction(transactionId: string): Promise<WagerTransaction | undefined> {
    const rows = await this.em.execute(`select ${TX_COLUMNS} from wager_transactions where id = ?`, [transactionId]);
    return rows[0] ? this.toStored(rows[0]).transaction : undefined;
  }

  async listLedger(
    walletId: string,
    cursor: { createdAt: string; id: string } | undefined,
    limit: number,
  ): Promise<LedgerPage> {
    const params: unknown[] = [walletId];
    let cursorSql = '';
    if (cursor) {
      cursorSql = 'and (created_at, id) > (?::timestamptz, ?::uuid)';
      params.push(cursor.createdAt, cursor.id);
    }
    params.push(limit + 1);

    const rows = await this.em.execute(
      `select id, wallet_id, transaction_id, direction, amount::text as amount, currency,
              balance_before::text as balance_before, balance_after::text as balance_after,
              ${ts('created_at')} as created_at, ${cursorTs('created_at')} as cursor_created_at
         from wallet_ledger_entries
        where wallet_id = ? ${cursorSql}
        order by created_at, id
        limit ?`,
      params,
    );
    const hasMore = rows.length > limit;
    const lastRow = hasMore ? rows[limit - 1] : undefined;
    return {
      entries: rows.slice(0, limit).map((row: Record<string, any>) => {
        const currency: string = row.currency;
        return WalletLedgerEntry.rehydrate({
          id: row.id,
          walletId: row.wallet_id,
          transactionId: row.transaction_id,
          direction: row.direction as LedgerDirection,
          money: Money.fromPersisted({ amount: row.amount, currency }),
          balanceBefore: Money.fromPersisted({ amount: row.balance_before, currency }),
          balanceAfter: Money.fromPersisted({ amount: row.balance_after, currency }),
          createdAt: new Date(row.created_at),
        });
      }),
      hasMore,
      ...(lastRow && {
        nextCursorPosition: { createdAt: lastRow.cursor_created_at, id: lastRow.id },
      }),
    };
  }

  async reconcileWallet(
    walletId: string,
  ): Promise<{ storedBalance: Money; calculatedBalance: Money; checkedEntries: number } | undefined> {
    const rows = await this.em.execute(
      `select w.balance::text as stored_balance, w.currency,
              coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::text as calculated_balance,
              count(l.id)::int as checked_entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id, w.balance, w.currency`,
      [walletId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      storedBalance: Money.fromPersisted({ amount: row.stored_balance, currency: row.currency }),
      calculatedBalance: Money.fromPersisted({ amount: row.calculated_balance, currency: row.currency }),
      checkedEntries: row.checked_entries,
    };
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const rows = await this.em.execute(
      `select 1 from wager_transactions
        where reference_transaction_id = ? and kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  async insertTransaction(tx: WagerTransaction, observedBalance: Money): Promise<void> {
    await this.em.execute(
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id,
          game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status,
          failure_code, created_at, processed_at, observed_balance)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.toString(),
        tx.money.currency,
        tx.referenceExternalTransactionId ?? null,
        tx.referenceTransactionId ?? null,
        tx.status,
        tx.failureCode ?? null,
        tx.createdAt,
        tx.processedAt ?? null,
        observedBalance.toString(),
      ],
    );
  }

  async insertLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    await this.em.execute(
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.toString(),
        entry.money.currency,
        entry.balanceBefore.toString(),
        entry.balanceAfter.toString(),
        entry.createdAt,
      ],
    );
  }

  // só lê (sem lock): quem decide é o lock por transação, feito depois do lock da carteira
  async findDuePendingReferences(limit: number): Promise<{ id: string; walletId: string }[]> {
    const rows = await this.em.execute(
      `select id, wallet_id from wager_transactions
        where status = 'PENDING_REFERENCE' and coalesce(next_reprocess_at, created_at) <= now()
        order by coalesce(next_reprocess_at, created_at)
        limit ?`,
      [limit],
    );
    return rows.map((row: Record<string, any>) => ({ id: row.id, walletId: row.wallet_id }));
  }

  async lockPendingTransaction(
    transactionId: string,
  ): Promise<{ transaction: WagerTransaction; attempts: number } | undefined> {
    const rows = await this.em.execute(
      `select ${TX_COLUMNS}, reprocess_attempts from wager_transactions
        where id = ? and status = 'PENDING_REFERENCE' for update skip locked`,
      [transactionId],
    );
    const row = rows[0];
    return row ? { transaction: this.toStored(row).transaction, attempts: row.reprocess_attempts } : undefined;
  }

  async updateTransactionOutcome(tx: WagerTransaction, observedBalance: Money): Promise<void> {
    await this.em.execute(
      `update wager_transactions
          set status = ?, failure_code = ?, reference_transaction_id = ?, processed_at = ?,
              observed_balance = ?, next_reprocess_at = null
        where id = ?`,
      [
        tx.status,
        tx.failureCode ?? null,
        tx.referenceTransactionId ?? null,
        tx.processedAt ?? null,
        observedBalance.toString(),
        tx.id,
      ],
    );
  }

  async scheduleReprocess(transactionId: string, attempts: number, delayMs: number): Promise<void> {
    await this.em.execute(
      `update wager_transactions
          set reprocess_attempts = ?, next_reprocess_at = now() + (? * interval '1 millisecond')
        where id = ?`,
      [attempts, delayMs, transactionId],
    );
  }

  async insertOutbox(event: IntegrationEvent<unknown>): Promise<void> {
    await this.em.execute(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
       values (?, ?, ?, ?::jsonb, ?)`,
      [event.eventId, event.aggregateId, event.eventType, JSON.stringify(event.toJSON()), event.occurredAt],
    );
  }

  private toWallet(row: Record<string, any>): Wallet {
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.player_id,
      currency: row.currency,
      balance: Money.fromPersisted({ amount: row.balance, currency: row.currency }),
      version: row.version,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
  }

  private toStored(row: Record<string, any>): StoredTransaction {
    const currency: string = row.currency;
    const transaction = WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind as WagerTransactionKind,
      money: Money.fromPersisted({ amount: row.amount, currency }),
      referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
      now: new Date(row.created_at),
      status: row.status as WagerTransactionStatus,
      referenceTransactionId: row.reference_transaction_id ?? undefined,
      failureCode: (row.failure_code ?? undefined) as FailureCode | undefined,
      processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
    });
    const observedBalance =
      row.observed_balance !== null ? Money.fromPersisted({ amount: row.observed_balance, currency }) : undefined;
    return { transaction, observedBalance };
  }
}

export { LedgerDirection };
