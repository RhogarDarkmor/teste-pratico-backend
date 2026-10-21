import { describe, expect, test } from 'bun:test';
import { InvalidMessageError, IdempotencyConflictError, WalletNotFoundError } from '../../src/application/errors';
import { parseWagerMessage } from '../../src/application/wager-message';
import { InboxMessage } from '../../src/domain/events/inbox-message';
import { InvalidMoneyError } from '../../src/domain/errors/money.errors';
import { classifyFailure } from '../../src/infra/sqs/sqs-consumer';

const valid = {
  messageId: 'msg-1',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-1',
    idempotencyKey: 'provider-a:transaction-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
};

const body = (override: (m: any) => void = () => {}) => {
  const copy = structuredClone(valid) as any;
  override(copy);
  return JSON.stringify(copy);
};

describe('parseWagerMessage', () => {
  test('converte a mensagem em comando do caso de uso', () => {
    const { messageId, command } = parseWagerMessage(body());
    expect(messageId).toBe('msg-1');
    expect(command).toMatchObject({
      providerId: 'provider-a',
      idempotencyKey: 'provider-a:transaction-1',
      kind: 'BET',
      amount: '25.00',
      currency: 'BRL',
      correlationId: 'msg-1',
    });
  });

  test('repassa a referência de estorno', () => {
    const { command } = parseWagerMessage(
      body((m) => {
        m.data.kind = 'REFUND';
        m.data.referenceExternalTransactionId = 'transaction-0';
      }),
    );
    expect(command.referenceExternalTransactionId).toBe('transaction-0');
  });

  test.each([
    ['json inválido', () => parseWagerMessage('{nao-e-json')],
    ['tipo desconhecido', () => parseWagerMessage(body((m) => (m.type = 'Outra')))],
    ['sem messageId', () => parseWagerMessage(body((m) => delete m.messageId))],
    ['OPENING não é aceito pela fila', () => parseWagerMessage(body((m) => (m.data.kind = 'OPENING')))],
    ['sem money', () => parseWagerMessage(body((m) => delete m.data.money))],
    ['campo vazio', () => parseWagerMessage(body((m) => (m.data.gameId = ' ')))],
  ])('recusa: %s', (_name, run) => {
    expect(run).toThrow(InvalidMessageError);
  });
});

describe('classifyFailure', () => {
  test('erros de negócio e mensagem inválida são permanentes', () => {
    expect(classifyFailure(new InvalidMessageError('x'))).toBe('permanent');
    expect(classifyFailure(new IdempotencyConflictError('x'))).toBe('permanent');
    expect(classifyFailure(new WalletNotFoundError('x'))).toBe('permanent');
    expect(classifyFailure(new InvalidMoneyError('x'))).toBe('permanent');
  });

  test('falha de infraestrutura é transitória', () => {
    expect(classifyFailure(Object.assign(new Error('conn'), { code: 'ECONNREFUSED' }))).toBe('transient');
    expect(classifyFailure(new Error('inesperado'))).toBe('transient');
  });
});

describe('InboxMessage', () => {
  test('nasce não processada e marca uma vez só', () => {
    const msg = InboxMessage.receive({
      messageId: 'm',
      consumerName: 'c',
      payloadHash: 'h',
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(new Date('2026-01-01T00:00:01Z'));
    msg.markProcessed(new Date('2026-01-01T00:00:09Z'));
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt?.toISOString()).toBe('2026-01-01T00:00:01.000Z');
  });
});
