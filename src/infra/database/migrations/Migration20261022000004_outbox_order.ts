import { Migration } from '@mikro-orm/migrations';

export class Migration20261022000004_outbox_order extends Migration {
  override up(): void {
    this.addSql(`alter table outbox_messages add column sequence_id bigserial not null`);
    this.addSql(`
      with ordered_messages as (
        select id, row_number() over (order by occurred_at, id) as sequence_id
          from outbox_messages
      )
      update outbox_messages as message
         set sequence_id = ordered_messages.sequence_id
        from ordered_messages
       where message.id = ordered_messages.id
    `);
    this.addSql(`drop index outbox_pending_idx`);
    this.addSql(`
      create index outbox_pending_idx
        on outbox_messages (coalesce(next_attempt_at, occurred_at), sequence_id)
        where published_at is null
    `);
    this.addSql(`create unique index outbox_sequence_id_uq on outbox_messages (sequence_id)`);
  }

  override down(): void {
    this.addSql(`drop index outbox_sequence_id_uq`);
    this.addSql(`drop index outbox_pending_idx`);
    this.addSql(`
      create index outbox_pending_idx
        on outbox_messages (coalesce(next_attempt_at, occurred_at), occurred_at)
        where published_at is null
    `);
    this.addSql(`alter table outbox_messages drop column sequence_id`);
  }
}
