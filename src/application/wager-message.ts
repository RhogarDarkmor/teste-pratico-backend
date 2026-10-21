import { WagerTransactionKind } from '../domain/wagering/wager-transaction';
import { InvalidMessageError } from './errors';
import type { SubmitWagerCommand } from './submit-wager-transaction.use-case';

export const WAGER_REQUESTED = 'WagerTransactionRequested';

export interface WagerMessage {
  messageId: string;
  command: SubmitWagerCommand;
}

type Json = Record<string, unknown>;

const KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

function obj(value: unknown, name: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidMessageError(`${name} must be an object`);
  }
  return value as Json;
}

function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidMessageError(`${name} must be a non-empty string`);
  }
  return value;
}

export function parseWagerMessage(body: string): WagerMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new InvalidMessageError('message body is not valid JSON');
  }
  const message = obj(raw, 'message');
  const messageId = str(message.messageId, 'messageId');
  if (message.type !== WAGER_REQUESTED) {
    throw new InvalidMessageError(`unsupported message type: ${String(message.type)}`);
  }
  const data = obj(message.data, 'data');
  const money = obj(data.money, 'data.money');
  const kind = str(data.kind, 'data.kind');
  if (!KINDS.has(kind)) {
    throw new InvalidMessageError('data.kind is not supported');
  }
  const reference = data.referenceExternalTransactionId;
  if (reference !== undefined && (typeof reference !== 'string' || reference.trim() === '')) {
    throw new InvalidMessageError('data.referenceExternalTransactionId must be a non-empty string');
  }

  return {
    messageId,
    command: {
      providerId: str(data.providerId, 'data.providerId'),
      externalTransactionId: str(data.externalTransactionId, 'data.externalTransactionId'),
      idempotencyKey: str(data.idempotencyKey, 'data.idempotencyKey'),
      walletId: str(data.walletId, 'data.walletId'),
      playerId: str(data.playerId, 'data.playerId'),
      roundId: str(data.roundId, 'data.roundId'),
      gameId: str(data.gameId, 'data.gameId'),
      kind: kind as WagerTransactionKind,
      amount: str(money.amount, 'data.money.amount'),
      currency: str(money.currency, 'data.money.currency'),
      ...(reference !== undefined && { referenceExternalTransactionId: reference }),
      correlationId: messageId,
    },
  };
}
