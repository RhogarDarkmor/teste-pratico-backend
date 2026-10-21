import type { EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../domain/events/outbox-message';

const ts = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export class OutboxRepository {
  constructor(private readonly em: Pick<EntityManager, 'execute'>) {}

  // Precisa rodar dentro de uma transação: o lock dura até o commit.
  // SKIP LOCKED faz cada publicador pegar um lote diferente, sem esperar um pelo outro.
  async claimPending(limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em.execute(
      `select id, aggregate_id, event_type, payload, ${ts('occurred_at')} as occurred_at, attempts,
              ${ts('next_attempt_at')} as next_attempt_at, ${ts('published_at')} as published_at
         from outbox_messages
        where published_at is null
          and coalesce(next_attempt_at, occurred_at) <= now()
        order by coalesce(next_attempt_at, occurred_at), occurred_at, id
        limit ?
        for update skip locked`,
      [limit],
    );
    return rows.map((row) => this.toMessage(row));
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
