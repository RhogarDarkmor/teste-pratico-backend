import { Migration } from '@mikro-orm/migrations';

export class Migration20261021000002_observed_balance extends Migration {
  override up(): void {
    this.addSql(`alter table wager_transactions add column observed_balance numeric(20,2)`);
    this.addSql(`
      alter table wager_transactions
        add constraint wager_tx_observed_balance_non_negative check (observed_balance is null or observed_balance >= 0)
    `);
  }

  override down(): void {
    this.addSql(`alter table wager_transactions drop column observed_balance`);
  }
}
