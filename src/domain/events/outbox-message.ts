import type { IntegrationEvent } from './integration-event';
import { backoffDelayMs, DEFAULT_BACKOFF, type BackoffOptions } from './backoff';

export interface OutboxMessageProps {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  private _attempts: number;
  private _nextAttemptAt: Date | undefined;
  private _publishedAt: Date | undefined;

  private constructor(props: OutboxMessageProps) {
    this.id = props.id;
    this.aggregateId = props.aggregateId;
    this.eventType = props.eventType;
    this.payload = props.payload;
    this.occurredAt = props.occurredAt;
    this._attempts = props.attempts;
    this._nextAttemptAt = props.nextAttemptAt;
    this._publishedAt = props.publishedAt;
  }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
    });
  }

  static rehydrate(props: OutboxMessageProps): OutboxMessage {
    return new OutboxMessage(props);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get isPublished(): boolean {
    return this._publishedAt !== undefined;
  }

  isPending(): boolean {
    return !this.isPublished;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    return (this._nextAttemptAt ?? this.occurredAt).getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this.assertPending('publish');
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  scheduleRetry(now: Date, backoff: BackoffOptions = DEFAULT_BACKOFF): void {
    this.assertPending('schedule a retry for');
    this._attempts++;
    this._nextAttemptAt = new Date(now.getTime() + backoffDelayMs(this._attempts, backoff));
  }

  private assertPending(action: string): void {
    if (!this.isPending()) {
      throw new Error(`Cannot ${action} a published outbox message`);
    }
  }
}
