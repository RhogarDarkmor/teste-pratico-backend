import type { EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../domain/events/outbox-message';

const ts = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export class OutboxRepository {
  constructor(private readonly em: Pick<EntityManager, 'execute'>) {}

  // SKIP LOCKED divide as mensagens entre os publishers até o commit
  async claimPending(limit: number): Promise<OutboxMessage[]> {
    // só libera o primeiro evento pendente de cada carteira
    const rows = await this.em.execute(
      `select id, aggregate_id, event_type, payload, ${ts('occurred_at')} as occurred_at, attempts,
              ${ts('next_attempt_at')} as next_attempt_at, ${ts('published_at')} as published_at
         from outbox_messages m
        where published_at is null
          and coalesce(next_attempt_at, occurred_at) <= now()
          and not exists (
            select 1 from outbox_messages o
             where o.aggregate_id = m.aggregate_id
               and o.published_at is null
               and o.sequence_id < m.sequence_id
          )
        order by coalesce(next_attempt_at, occurred_at), sequence_id
        limit ?
        for update of m skip locked`,
      [limit],
    );
    return rows.map((row) => this.toMessage(row));
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.em.execute(
      `update outbox_messages set published_at = ?, next_attempt_at = null where id = ?`,
      [message.publishedAt, message.id],
    );
  }

  async markFailed(message: OutboxMessage): Promise<void> {
    if (!message.nextAttemptAt) {
      throw new Error(`Outbox message ${message.id} has no scheduled retry`);
    }
    await this.em.execute(
      `update outbox_messages
          set attempts = ?, next_attempt_at = ?
        where id = ?`,
      [message.attempts, message.nextAttemptAt, message.id],
    );
  }

  private toMessage(row: Record<string, any>): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: row.id,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: row.payload,
      occurredAt: new Date(row.occurred_at),
      attempts: row.attempts,
      ...(row.next_attempt_at ? { nextAttemptAt: new Date(row.next_attempt_at) } : {}),
      ...(row.published_at ? { publishedAt: new Date(row.published_at) } : {}),
    });
  }
}
