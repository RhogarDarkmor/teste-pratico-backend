export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private _processedAt: Date | undefined;

  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    processedAt?: Date,
  ) {
    this._processedAt = processedAt;
  }

  static receive(props: { messageId: string; consumerName: string; payloadHash: string; now: Date }): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.now);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this._processedAt) return;
    this._processedAt = at;
  }
}
