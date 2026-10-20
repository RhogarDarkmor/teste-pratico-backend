import { UnbalancedLedgerEntryError } from '../errors/wallet.errors';
import { Money } from '../money/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: LedgerEntryState): WalletLedgerEntry {
    const entry = WalletLedgerEntry.build(props);
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `${props.balanceBefore} ${props.direction} ${props.money} does not result in ${props.balanceAfter}`,
      );
    }
    return entry;
  }

  /** Estado já persistido: não revalida. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  private static build(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      s.id,
      s.walletId,
      s.transactionId,
      s.direction,
      s.money,
      s.balanceBefore,
      s.balanceAfter,
      s.createdAt,
    );
  }
}
