import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { IdempotencyConflictError, InvalidMessageError, WalletNotFoundError } from '../../application/errors';
import { DomainError } from '../../domain/errors/domain-error';
import { metrics } from '../../observability/metrics';
import { backoffDelayMs, type BackoffOptions } from '../../domain/events/backoff';

export interface MessageProcessor {
  execute(body: string): Promise<unknown>;
}

export interface SqsConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  maxAttempts: number;
  waitTimeSeconds: number;
  backoff: BackoffOptions;
}

export interface ConsumerLogger {
  log(message: string | object): void;
  warn(message: string | object): void;
  error(message: string | object): void;
}

export type Failure = 'permanent' | 'transient';

// permanente vai pra DLQ, o resto tenta de novo com backoff
export function classifyFailure(error: unknown): Failure {
  if (
    error instanceof InvalidMessageError ||
    error instanceof IdempotencyConflictError ||
    error instanceof WalletNotFoundError ||
    error instanceof DomainError
  ) {
    return 'permanent';
  }
  return 'transient';
}

export class SqsConsumer {
  private running = false;
  private stopping = false;
  private loop: Promise<void> | undefined;
  private abort: AbortController | undefined;

  constructor(
    private readonly sqs: Pick<SQSClient, 'send'>,
    private readonly processor: MessageProcessor,
    private readonly options: SqsConsumerOptions,
    private readonly logger: ConsumerLogger = console,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    this.abort?.abort();
    await this.loop;
  }

  async pollOnce(signal?: AbortSignal): Promise<number> {
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      signal ? { abortSignal: signal } : undefined,
    );
    const messages = response.Messages ?? [];

    // ordem dentro do grupo, grupos diferentes em paralelo
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId!;
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all([...groups.values()].map((group) => this.handleGroup(group)));
    return messages.length;
  }

  private async handleGroup(messages: Message[]): Promise<void> {
    for (let i = 0; i < messages.length; i++) {
      // no shutdown ou depois de uma falha, devolve as próximas do grupo
      if (this.stopping) {
        await this.release(messages.slice(i));
        return;
      }
      const resolved = await this.handle(messages[i]!);
      if (!resolved) {
        await this.release(messages.slice(i + 1));
        return;
      }
    }
  }

  private async handle(message: Message): Promise<boolean> {
    try {
      await this.processor.execute(message.Body ?? '');
    } catch (error) {
      return this.handleFailure(message, error);
    }
    // ack só depois do commit, se o delete falhar a inbox segura a redelivery
    return this.ack(message);
  }

  private async handleFailure(message: Message, error: unknown): Promise<boolean> {
    const reason = error instanceof Error ? error.message : String(error);
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const kind = classifyFailure(error);

    if (kind === 'permanent' || receiveCount >= this.options.maxAttempts) {
      this.logger.error({
        message: 'message sent to DLQ',
        messageId: message.MessageId,
        walletId: message.Attributes?.MessageGroupId,
        failure: kind,
        receiveCount,
        reason,
      });
      try {
        await this.sendToDlq(message, reason);
      } catch (dlqError) {
        this.logger.error({ message: 'could not send to DLQ', messageId: message.MessageId, reason: (dlqError as Error).message });
        return false;
      }
      metrics.dlqMessages.inc({ kind });
      metrics.sqsMessages.inc({ outcome: 'dlq' });
      return this.ack(message);
    }

    const delaySeconds = Math.ceil(backoffDelayMs(receiveCount, this.options.backoff) / 1000);
    metrics.sqsRetries.inc();
    metrics.sqsMessages.inc({ outcome: 'retry' });
    this.logger.warn({
      message: 'message failed, will retry',
      messageId: message.MessageId,
      walletId: message.Attributes?.MessageGroupId,
      receiveCount,
      retryInSeconds: delaySeconds,
      reason,
    });
    await this.changeVisibility(message, delaySeconds);
    return false;
  }

  private async ack(message: Message): Promise<boolean> {
    try {
      await this.sqs.send(
        new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle! }),
      );
      return true;
    } catch (error) {
      this.logger.warn(`Could not ack ${message.MessageId}: ${(error as Error).message}`);
      return false;
    }
  }

  private async sendToDlq(message: Message, reason: string): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
        MessageDeduplicationId: message.MessageId!,
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason.slice(0, 500) || 'unknown' },
        },
      }),
    );
  }

  private async release(messages: Message[]): Promise<void> {
    await Promise.all(messages.map((message) => this.changeVisibility(message, 0)));
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle!,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      this.logger.warn(`Could not change visibility of ${message.MessageId}: ${(error as Error).message}`);
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      this.abort = new AbortController();
      try {
        await this.pollOnce(this.abort.signal);
      } catch (error) {
        if (!this.running) break;
        this.logger.error(`SQS poll failed: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
}
