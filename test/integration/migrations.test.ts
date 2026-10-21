import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: false });
});

afterAll(async () => {
  await db.drop();
});

const tables = async () =>
  (
    await db.sql(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name not like 'mikro_orm%' order by 1`,
    )
  ).map((r) => r.table_name as string);

describe('migrations', () => {
  test('up cria o schema e cada down desfaz uma migration até zerar (reversível)', async () => {
    expect(await tables()).toEqual([]);

    await db.migrator.up();
    expect(await tables()).toEqual([
      'inbox_messages',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);

    await db.migrator.down();
    await db.migrator.down();
    await db.migrator.down();
    expect(await tables()).toEqual([]);
    const fn = await db.sql(`select 1 from pg_proc where proname = 'forbid_ledger_change'`);
    expect(fn).toHaveLength(0);
  });

  test('pode subir de novo depois de desfeita e não repete se já aplicada', async () => {
    await db.migrator.up();
    await db.migrator.up();
    expect(await tables()).toHaveLength(5);
    expect(await db.migrator.getPending()).toHaveLength(0);
  });
});
