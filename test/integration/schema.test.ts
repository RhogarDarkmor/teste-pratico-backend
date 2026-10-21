import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

const HASH = 'a'.repeat(64);
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

async function insertWallet(overrides: Record<string, unknown> = {}) {
  const wallet = {
    id: randomUUID(),
    player_id: randomUUID(),
    currency: 'BRL',
    balance: '100.00',
    version: 1,
    ...overrides,
  };
  await db.sql(
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, ?, ?, ?, now(), now())`,
    [wallet.id, wallet.player_id, wallet.currency, wallet.balance, wallet.version],
  );
  return wallet;
}

async function insertTx(walletId: string, overrides: Record<string, unknown> = {}) {
  const external = randomUUID();
  const tx = {
    id: randomUUID(),
    provider_id: 'provider-a',
    external_transaction_id: external,
    idempotency_key: `provider-a:${external}`,
    payload_hash: HASH,
    wallet_id: walletId,
    kind: 'BET',
    amount: '25.00',
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: 'PENDING',
    failure_code: null,
    processed_at: null,
    ...overrides,
  };
  await db.sql(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id,
        game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status,
        failure_code, created_at, processed_at)
     values (?, ?, ?, ?, ?, ?, 'p1', 'r1', 'g1', ?, ?, 'BRL', ?, ?, ?, ?, now(), ?)`,
    [
      tx.id,
      tx.provider_id,
      tx.external_transaction_id,
      tx.idempotency_key,
      tx.payload_hash,
      tx.wallet_id,
      tx.kind,
      tx.amount,
      tx.reference_external_transaction_id,
      tx.reference_transaction_id,
      tx.status,
      tx.failure_code,
      tx.processed_at,
    ],
  );
  return tx;
}

async function insertLedger(walletId: string, transactionId: string, overrides: Record<string, unknown> = {}) {
  const entry = {
    direction: 'DEBIT',
    amount: '25.00',
    balance_before: '100.00',
    balance_after: '75.00',
    ...overrides,
  };
  const id = randomUUID();
  await db.sql(
    `insert into wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
     values (?, ?, ?, ?, ?, 'BRL', ?, ?, now())`,
    [id, walletId, transactionId, entry.direction, entry.amount, entry.balance_before, entry.balance_after],
  );
  return id;
}

describe('wallets', () => {
  test('saldo negativo é recusado pelo banco', async () => {
    await expect(insertWallet({ balance: '-0.01' })).rejects.toThrow(/wallets_balance_non_negative/);
  });

  test('uma wallet por player e moeda', async () => {
    const first = await insertWallet();
    await expect(insertWallet({ player_id: first.player_id })).rejects.toThrow(/wallets_player_currency_uq/);
    await expect(insertWallet({ player_id: first.player_id, currency: 'USD' })).resolves.toBeDefined();
  });

  test('versão precisa ser >= 1 e moeda tem formato ISO', async () => {
    await expect(insertWallet({ version: 0 })).rejects.toThrow(/wallets_version_positive/);
    await expect(insertWallet({ currency: 'brl' })).rejects.toThrow(/wallets_currency_format/);
  });

  test('o saldo guarda exatamente 2 casas', async () => {
    const wallet = await insertWallet({ balance: '0.10' });
    await db.sql(`update wallets set balance = balance + 0.20 where id = ?`, [wallet.id]);
    const [row] = await db.sql(`select balance::text as balance from wallets where id = ?`, [wallet.id]);
    expect(row.balance).toBe('0.30');
  });
});

describe('wager_transactions', () => {
  test('mesma (provider, external id) não entra duas vezes', async () => {
    const wallet = await insertWallet();
    const tx = await insertTx(wallet.id);
    await expect(
      insertTx(wallet.id, { external_transaction_id: tx.external_transaction_id }),
    ).rejects.toThrow(/wager_tx_provider_external_uq/);
  });

  test('mesmo external id em outro provider é permitido', async () => {
    const wallet = await insertWallet();
    const tx = await insertTx(wallet.id);
    await expect(
      insertTx(wallet.id, { provider_id: 'provider-b', external_transaction_id: tx.external_transaction_id }),
    ).resolves.toBeDefined();
  });

  test('idempotency key é única', async () => {
    const wallet = await insertWallet();
    const tx = await insertTx(wallet.id);
    await expect(insertTx(wallet.id, { idempotency_key: tx.idempotency_key })).rejects.toThrow(
      /wager_tx_idempotency_key_uq/,
    );
  });

  test('só aceita tipo e status conhecidos', async () => {
    const wallet = await insertWallet();
    await expect(insertTx(wallet.id, { kind: 'DEPOSIT' })).rejects.toThrow(/wager_tx_kind_valid/);
    await expect(insertTx(wallet.id, { status: 'DONE' })).rejects.toThrow(/wager_tx_status_valid/);
  });

  test('valor zero só em LOSS, negativo nunca', async () => {
    const wallet = await insertWallet();
    await expect(insertTx(wallet.id, { amount: '0.00' })).rejects.toThrow(/wager_tx_amount_valid/);
    await expect(insertTx(wallet.id, { amount: '-1.00' })).rejects.toThrow(/wager_tx_amount_valid/);
    await expect(insertTx(wallet.id, { kind: 'LOSS', amount: '0.00' })).resolves.toBeDefined();
  });

  test('REFUND e ROLLBACK exigem referência', async () => {
    const wallet = await insertWallet();
    await expect(insertTx(wallet.id, { kind: 'REFUND' })).rejects.toThrow(/wager_tx_reversal_has_reference/);
    await expect(insertTx(wallet.id, { kind: 'ROLLBACK' })).rejects.toThrow(/wager_tx_reversal_has_reference/);
  });

  test('REJECTED e FAILED exigem failure_code; os outros não podem ter', async () => {
    const wallet = await insertWallet();
    await expect(insertTx(wallet.id, { status: 'REJECTED' })).rejects.toThrow(/wager_tx_failure_code_required/);
    await expect(insertTx(wallet.id, { status: 'FAILED' })).rejects.toThrow(/wager_tx_failure_code_required/);
    await expect(insertTx(wallet.id, { status: 'PENDING', failure_code: 'X' })).rejects.toThrow(
      /wager_tx_failure_code_required/,
    );
    await expect(
      insertTx(wallet.id, { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' }),
    ).resolves.toBeDefined();
  });

  test('PROCESSED exige processed_at', async () => {
    const wallet = await insertWallet();
    await expect(insertTx(wallet.id, { status: 'PROCESSED' })).rejects.toThrow(/wager_tx_processed_at_required/);
    await expect(insertTx(wallet.id, { processed_at: new Date() })).rejects.toThrow(/wager_tx_processed_at_required/);
  });

  test('wallet precisa existir', async () => {
    await expect(insertTx(randomUUID())).rejects.toThrow(/foreign key/i);
  });

  test('uma referência não pode ser revertida duas vezes (refund ou rollback)', async () => {
    const wallet = await insertWallet();
    const bet = await insertTx(wallet.id, { status: 'PROCESSED', processed_at: new Date() });
    const reversal = (kind: string) =>
      insertTx(wallet.id, {
        kind,
        status: 'PROCESSED',
        processed_at: new Date(),
        reference_external_transaction_id: bet.external_transaction_id,
        reference_transaction_id: bet.id,
      });

    await reversal('REFUND');
    await expect(reversal('REFUND')).rejects.toThrow(/wager_tx_single_reversal_uq/);
    await expect(reversal('ROLLBACK')).rejects.toThrow(/wager_tx_single_reversal_uq/);
  });

  test('reversão rejeitada não bloqueia uma nova tentativa válida', async () => {
    const wallet = await insertWallet();
    const bet = await insertTx(wallet.id, { status: 'PROCESSED', processed_at: new Date() });
    const base = {
      kind: 'REFUND',
      reference_external_transaction_id: bet.external_transaction_id,
      reference_transaction_id: bet.id,
    };
    await insertTx(wallet.id, { ...base, status: 'REJECTED', failure_code: 'REFERENCE_AMOUNT_MISMATCH' });
    await expect(
      insertTx(wallet.id, { ...base, status: 'PROCESSED', processed_at: new Date() }),
    ).resolves.toBeDefined();
  });
});

describe('wallet_ledger_entries', () => {
  async function setup() {
    const wallet = await insertWallet();
    const tx = await insertTx(wallet.id);
    return { wallet, tx };
  }

  test('lançamento coerente entra', async () => {
    const { wallet, tx } = await setup();
    await expect(insertLedger(wallet.id, tx.id)).resolves.toBeDefined();
  });

  test('aritmética errada é recusada nas duas direções', async () => {
    const { wallet, tx } = await setup();
    await expect(insertLedger(wallet.id, tx.id, { balance_after: '70.00' })).rejects.toThrow(/ledger_arithmetic/);
    await expect(
      insertLedger(wallet.id, tx.id, { direction: 'CREDIT', balance_after: '75.00' }),
    ).rejects.toThrow(/ledger_arithmetic/);
    await expect(
      insertLedger(wallet.id, tx.id, { direction: 'CREDIT', balance_after: '125.00' }),
    ).resolves.toBeDefined();
  });

  test('saldo depois do lançamento não pode ser negativo', async () => {
    const { wallet, tx } = await setup();
    await expect(
      insertLedger(wallet.id, tx.id, { balance_before: '10.00', balance_after: '-15.00' }),
    ).rejects.toThrow(/ledger_balances_non_negative/);
  });

  test('uma transação gera no máximo um lançamento por wallet', async () => {
    const { wallet, tx } = await setup();
    await insertLedger(wallet.id, tx.id);
    await expect(insertLedger(wallet.id, tx.id)).rejects.toThrow(/ledger_wallet_transaction_uq/);
  });

  test('valor precisa ser positivo e direção válida', async () => {
    const { wallet, tx } = await setup();
    await expect(
      insertLedger(wallet.id, tx.id, { amount: '0.00', balance_after: '100.00' }),
    ).rejects.toThrow(/ledger_amount_positive/);
    // o postgres reporta a primeira check que falha, e a aritmética também quebra com direção inválida
    await expect(insertLedger(wallet.id, tx.id, { direction: 'SIDEWAYS' })).rejects.toThrow(
      /ledger_(direction_valid|arithmetic)/,
    );
  });

  test('é append-only: UPDATE, DELETE e TRUNCATE são bloqueados', async () => {
    const { wallet, tx } = await setup();
    const id = await insertLedger(wallet.id, tx.id);
    await expect(db.sql(`update wallet_ledger_entries set amount = 1 where id = ?`, [id])).rejects.toThrow(
      /append-only/,
    );
    await expect(db.sql(`delete from wallet_ledger_entries where id = ?`, [id])).rejects.toThrow(/append-only/);
    await expect(db.sql(`truncate wallet_ledger_entries`)).rejects.toThrow(/append-only/);
    const [row] = await db.sql(`select amount::text as amount from wallet_ledger_entries where id = ?`, [id]);
    expect(row.amount).toBe('25.00');
  });
});

describe('inbox e outbox', () => {
  test('inbox deduplica por (consumer, message)', async () => {
    const insert = (consumer: string, message: string) =>
      db.sql(
        `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (?, ?, ?, now())`,
        [consumer, message, HASH],
      );
    await insert('wager-consumer', 'msg-1');
    await expect(insert('wager-consumer', 'msg-1')).rejects.toThrow(/inbox_messages_pkey/);
    await expect(insert('outro-consumer', 'msg-1')).resolves.toBeDefined();
  });

  test('outbox nasce pendente e não aceita tentativas negativas', async () => {
    const insert = (attempts: number) =>
      db.sql(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
         values (?, 'w1', 'WalletBalanceChanged', '{"a":1}'::jsonb, now(), ?)`,
        [randomUUID(), attempts],
      );
    await expect(insert(0)).resolves.toBeDefined();
    await expect(insert(-1)).rejects.toThrow(/outbox_attempts_non_negative/);
    const [row] = await db.sql(`select count(*)::int as n from outbox_messages where published_at is null`);
    expect(row.n).toBe(1);
  });
});
