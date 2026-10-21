import { Money } from '../../src/domain/money/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from '../../src/domain/wagering/wager-transaction';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const now = new Date('2026-01-01T00:00:00Z');

export function makeTx(overrides: Partial<CreateWagerTransactionProps> = {}) {
  return WagerTransaction.create({
    id: 't1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    now,
    ...overrides,
  });
}
