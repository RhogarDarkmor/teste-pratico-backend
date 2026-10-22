import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration20261021000001_initial_schema } from './migrations/Migration20261021000001_initial_schema';
import { Migration20261021000002_observed_balance } from './migrations/Migration20261021000002_observed_balance';
import { Migration20261021000003_pending_reference_retry } from './migrations/Migration20261021000003_pending_reference_retry';
import { Migration20261022000004_outbox_order } from './migrations/Migration20261022000004_outbox_order';

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
        {
          name: 'Migration20261021000002_observed_balance',
          class: Migration20261021000002_observed_balance,
        },
        {
          name: 'Migration20261021000003_pending_reference_retry',
          class: Migration20261021000003_pending_reference_retry,
        },
        {
          name: 'Migration20261022000004_outbox_order',
          class: Migration20261022000004_outbox_order,
        },
      ],
    },
  });
}
