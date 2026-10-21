export interface OutboxMessageProps {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

// Mensagem do outbox: o evento já serializado, esperando para ir ao SQS.
export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt?: Date;
  readonly publishedAt?: Date;

  private constructor(props: OutboxMessageProps) {
    this.id = props.id;
    this.aggregateId = props.aggregateId;
    this.eventType = props.eventType;
    this.payload = props.payload;
    this.occurredAt = props.occurredAt;
    this.attempts = props.attempts;
    if (props.nextAttemptAt) this.nextAttemptAt = props.nextAttemptAt;
    if (props.publishedAt) this.publishedAt = props.publishedAt;
  }

  static rehydrate(props: OutboxMessageProps): OutboxMessage {
    return new OutboxMessage(props);
  }

  get isPublished(): boolean {
    return this.publishedAt !== undefined;
  }

  // sem nextAttemptAt a mensagem está disponível desde que ocorreu
  isDue(now: Date): boolean {
    if (this.isPublished) return false;
    return (this.nextAttemptAt ?? this.occurredAt).getTime() <= now.getTime();
  }
}
