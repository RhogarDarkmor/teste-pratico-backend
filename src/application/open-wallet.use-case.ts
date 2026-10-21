import type { EntityManager } from '@mikro-orm/postgresql';
import { WalletBalanceChanged } from '../domain/events/wagering-events';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import { Money } from '../domain/money/money';
import { WagerTransaction } from '../domain/wagering/wager-transaction';
import { Wallet } from '../domain/wallet/wallet';
import { WageringRepository } from '../infra/persistence/wagering.repository';
import { newId } from '../shared/ids';
import { WalletAlreadyExistsError } from './errors';

export interface OpenWalletCommand {
  playerId: string;
  currency: string;
  initialBalance: string;
  correlationId?: string;
}

export interface OpenWalletResult {
  walletId: string;
  playerId: string;
  currency: string;
  balance: Money;
}

export class OpenWalletUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    const initial = Money.from({ amount: command.initialBalance, currency: command.currency });
    const now = this.clock();
    const wallet = Wallet.open({ id: newId(), playerId: command.playerId, initialBalance: initial, now });

    try {
      await this.em.transactional(async (tem) => {
        const repo = new WageringRepository(tem);
        await repo.insertWallet(wallet);
        if (!initial.isZero()) {
          await this.recordOpening(repo, wallet, initial, now, command.correlationId ?? newId());
        }
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new WalletAlreadyExistsError(`Wallet already exists for ${command.playerId}/${command.currency}`);
      }
      throw error;
    }

    return { walletId: wallet.id, playerId: wallet.playerId, currency: wallet.currency, balance: wallet.balance };
  }

  private async recordOpening(
    repo: WageringRepository,
    wallet: Wallet,
    initial: Money,
    now: Date,
    correlationId: string,
  ): Promise<void> {
    const tx = WagerTransaction.opening({
      id: newId(),
      providerId: 'internal',
      externalTransactionId: `opening:${wallet.id}`,
      idempotencyKey: `opening:${wallet.id}`,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'opening',
      gameId: 'opening',
      money: initial,
      now,
    });
    tx.markProcessed(undefined, now);

    const entry = WalletLedgerEntry.create({
      id: newId(),
      walletId: wallet.id,
      transactionId: tx.id,
      direction: LedgerDirection.Credit,
      money: initial,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: wallet.balance,
      createdAt: now,
    });

    await repo.insertTransaction(tx, wallet.balance);
    await repo.insertLedgerEntry(entry);
    await repo.insertOutbox(WalletBalanceChanged.from(wallet, entry, { eventId: newId(), correlationId, occurredAt: now }));
  }
}
