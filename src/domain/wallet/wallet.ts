import { InsufficientFundsError, InvalidMovementError } from '../errors/wallet.errors';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors/money.errors';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  amount: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; now?: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError('Initial balance cannot be negative');
    }
    const now = props.now ?? new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, now, now);
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.amount);
    if (this._balance.isLessThan(props.amount)) {
      throw new InsufficientFundsError(`Wallet ${this.id} has ${this._balance}, needs ${props.amount}`);
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(props.amount), props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.amount);
    return this.apply(LedgerDirection.Credit, this._balance.add(props.amount), props);
  }

  // saldo e ledger mudam juntos, só depois de tudo validado
  private apply(direction: LedgerDirection, next: Money, props: MovementProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.amount,
      balanceBefore: this._balance,
      balanceAfter: next,
      createdAt: props.at,
    });
    this._balance = next;
    this._version += 1;
    this._updatedAt = props.at;
    return entry;
  }

  private assertMovable(amount: Money): void {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new InvalidMovementError('Movement amount must be greater than zero');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
