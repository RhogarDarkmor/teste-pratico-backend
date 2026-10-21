import type { EntityManager } from '@mikro-orm/postgresql';
import { InboxMessage } from '../../domain/events/inbox-message';

const ts = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export class InboxRepository {
  constructor(private readonly em: Pick<EntityManager, 'execute'>) {}

  // Devolve a mensagem nova, ou a que já existia. Se outra transação está inserindo a mesma chave,
  // o insert espera ela terminar, então quem chega depois sempre enxerga o resultado final.
  async receive(message: InboxMessage): Promise<{ inserted: boolean; stored: InboxMessage }> {
    const rows = await this.em.execute(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    if (rows.length > 0) {
      return { inserted: true, stored: message };
    }
    const stored = await this.em.execute(
      `select consumer_name, message_id, payload_hash, ${ts('received_at')} as received_at,
              ${ts('processed_at')} as processed_at
         from inbox_messages where consumer_name = ? and message_id = ?`,
      [message.consumerName, message.messageId],
    );
    const row = stored[0]!;
    return {
      inserted: false,
      stored: InboxMessage.rehydrate({
        messageId: row.message_id,
        consumerName: row.consumer_name,
        payloadHash: row.payload_hash,
        receivedAt: new Date(row.received_at),
        ...(row.processed_at ? { processedAt: new Date(row.processed_at) } : {}),
      }),
    };
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.execute(
      `update inbox_messages set processed_at = ? where consumer_name = ? and message_id = ?`,
      [message.processedAt, message.consumerName, message.messageId],
    );
  }
}
