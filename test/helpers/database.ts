import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { buildOrmConfig, DEFAULT_DATABASE_URL } from '../../src/infra/database/orm.config';

const adminUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

export interface TestDatabase {
  orm: MikroORM;
  migrator: Migrator;
  sql: (query: string, params?: unknown[]) => Promise<any[]>;
  drop: () => Promise<void>;
}

// cada suíte tem banco próprio, separado do de dev e das outras
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const name = `wagering_test_${randomUUID().replaceAll('-', '')}`;

  const admin = await MikroORM.init(buildOrmConfig(adminUrl));
  await admin.em.getConnection().execute(`create database ${name}`);
  await admin.close();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const orm = await MikroORM.init(buildOrmConfig(url.toString()));
  const migrator = orm.migrator as Migrator;
  if (options.migrate ?? true) {
    await migrator.up();
  }

  return {
    orm,
    migrator,
    sql: (query, params) => orm.em.getConnection().execute(query, params as any[]),
    drop: async () => {
      await orm.close();
      const cleaner = await MikroORM.init(buildOrmConfig(adminUrl));
      await cleaner.em.getConnection().execute(`drop database if exists ${name} with (force)`);
      await cleaner.close();
    },
  };
}
