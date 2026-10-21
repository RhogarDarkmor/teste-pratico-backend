import type { EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../domain/events/outbox-message';

const ts = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export class OutboxRepository {
  constructor(private readonly em: Pick<EntityManager, 'execute'>) {}

  // Precisa rodar dentro de uma transação: o lock dura até o commit.
  // SKIP LOCKED faz cada publicador pegar um lote diferente, sem esperar um pelo outro.
  async claimPending(limit: number): Promise<OutboxMessage[]> {
    // a mensagem não é pega se uma anterior da mesma carteira está esperando backoff: ela vai primeiro
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
               and (o.occurred_at, o.id) < (m.occurred_at, m.id)
               and coalesce(o.next_attempt_at, o.occurred_at) > now()
          )
        order by coalesce(next_attempt_at, occurred_at), occurred_at, id
        limit ?
        for update of m skip locked`,
      [limit],
    );
    return rows.map((row) => this.toMessage(row));
  }

  async markPublished(id: string): Promise<void> {
    await this.em.execute(`update outbox_messages set published_at = now() where id = ?`, [id]);
  }

  async markFailed(id: string, attempts: number, retryInMs: number): Promise<void> {
    await this.em.execute(
      `update outbox_messages
          set attempts = ?, next_attempt_at = now() + (? * interval '1 millisecond')
        where id = ?`,
      [attempts, retryInMs, id],
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
