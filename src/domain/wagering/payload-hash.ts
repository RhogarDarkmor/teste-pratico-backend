import { createHash } from 'node:crypto';
import { Money } from '../money/money';

export interface PayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId: string | undefined;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const body = Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`);
    return `{${body.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// Hash apenas dos campos de negócio; a chave de idempotência fica de fora.
export function computePayloadHash(fields: PayloadFields): string {
  const canonical = canonicalize({
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: fields.money.toJSON(),
    referenceExternalTransactionId: fields.referenceExternalTransactionId ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
