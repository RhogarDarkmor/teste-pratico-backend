import { MikroORM } from '@mikro-orm/postgresql';
import type { Migrator } from '@mikro-orm/migrations';
import { buildOrmConfig } from './orm.config';

const command = process.argv[2];

async function main() {
  const orm = await MikroORM.init(buildOrmConfig());
  const migrator = orm.migrator as Migrator;
  try {
    if (command === 'up') {
      const done = await migrator.up();
      console.log(done.length ? done.map((m) => `applied ${m.name}`).join('\n') : 'nothing to apply');
    } else if (command === 'down') {
      const done = await migrator.down();
      console.log(done.length ? done.map((m) => `reverted ${m.name}`).join('\n') : 'nothing to revert');
    } else if (command === 'status') {
      const pending = await migrator.getPending();
      console.log(pending.length ? pending.map((m) => `pending ${m.name}`).join('\n') : 'up to date');
    } else {
      console.error('usage: migrate.ts <up|down|status>');
      process.exitCode = 1;
    }
  } finally {
    await orm.close();
  }
}

main();
