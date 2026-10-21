import type { EntityManager } from '@mikro-orm/postgresql';
import { WageringRepository } from '../infra/persistence/wagering.repository';
import { InvalidQueryError, WalletNotFoundError, WagerTransactionNotFoundError } from './errors';

const CURSOR_VERSION = 1;

export class QueryWalletsUseCase {
  private readonly repository: WageringRepository;

  constructor(em: EntityManager) {
    this.repository = new WageringRepository(em);
  }

  async getWallet(walletId: string) {
    const wallet = await this.repository.findWallet(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(`Wallet ${walletId} not found`);
    }
    return wallet;
  }

  async getTransaction(transactionId: string) {
    const transaction = await this.repository.findTransaction(transactionId);
    if (!transaction) {
      throw new WagerTransactionNotFoundError(`Transaction ${transactionId} not found`);
    }
    return transaction;
  }

  async getProviderTransaction(providerId: string, externalTransactionId: string) {
    const transaction = await this.repository.findByExternalId(providerId, externalTransactionId);
    if (!transaction) {
      throw new WagerTransactionNotFoundError(`Transaction ${providerId}/${externalTransactionId} not found`);
    }
    return transaction;
  }

  async getLedger(walletId: string, encodedCursor?: string, requestedLimit?: string) {
    const wallet = await this.getWallet(walletId);
    const limit = requestedLimit === undefined ? 50 : Number(requestedLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new InvalidQueryError('limit must be an integer between 1 and 100');
    }

    const cursor = encodedCursor === undefined ? undefined : decodeCursor(encodedCursor);
    const page = await this.repository.listLedger(walletId, cursor, limit);
    return {
      walletId,
      entries: page.entries,
      nextCursor: page.nextCursorPosition
        ? encodeCursor(page.nextCursorPosition.createdAt, page.nextCursorPosition.id)
        : null,
      currency: wallet.currency,
    };
  }

  async reconcile(walletId: string) {
    const result = await this.repository.reconcileWallet(walletId);
    if (!result) {
      throw new WalletNotFoundError(`Wallet ${walletId} not found`);
    }
    const difference = result.storedBalance.subtract(result.calculatedBalance);
    return {
      walletId,
      storedBalance: result.storedBalance,
      calculatedBalance: result.calculatedBalance,
      difference,
      consistent: difference.isZero(),
      checkedEntries: result.checkedEntries,
    };
  }
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, createdAt, id })).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('v' in decoded) ||
      decoded.v !== CURSOR_VERSION ||
      !('createdAt' in decoded) ||
      typeof decoded.createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(decoded.createdAt) ||
      !Number.isFinite(Date.parse(decoded.createdAt)) ||
      !('id' in decoded) ||
      typeof decoded.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.id)
    ) {
      throw new Error('Invalid cursor');
    }
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    throw new InvalidQueryError('cursor is invalid');
  }
}
