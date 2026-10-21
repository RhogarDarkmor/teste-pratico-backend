import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration20261021000001_initial_schema } from './migrations/Migration20261021000001_initial_schema';

export const DEFAULT_DATABASE_URL = 'postgres://wagering:wagering@localhost:5432/wagering';

export function buildOrmConfig(clientUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
  return defineConfig({
    clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      snapshot: false,
      migrationsList: [
        {
          name: 'Migration20261021000001_initial_schema',
          class: Migration20261021000001_initial_schema,
        },
      ],
    },
  });
}
