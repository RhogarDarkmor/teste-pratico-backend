import { Migration } from '@mikro-orm/migrations';

export class Migration20261021000003_pending_reference_retry extends Migration {
  override up(): void {
    this.addSql(`
      alter table wager_transactions
        add column reprocess_attempts integer not null default 0,
        add column next_reprocess_at timestamptz,
        add constraint wager_tx_reprocess_attempts_non_negative check (reprocess_attempts >= 0)
    `);
    // o índice antigo ordenava só por created_at; o worker filtra pela próxima tentativa
    this.addSql(`drop index wager_tx_pending_reference_idx`);
    this.addSql(`
      create index wager_tx_pending_reference_idx
        on wager_transactions (coalesce(next_reprocess_at, created_at))
        where status = 'PENDING_REFERENCE'
    `);
  }

  override down(): void {
    this.addSql(`drop index wager_tx_pending_reference_idx`);
    this.addSql(`
      create index wager_tx_pending_reference_idx
        on wager_transactions (created_at)
        where status = 'PENDING_REFERENCE'
    `);
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_tx_reprocess_attempts_non_negative,
        drop column next_reprocess_at,
        drop column reprocess_attempts
    `);
  }
}
