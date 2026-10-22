import DecimalJs from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors/money.errors';

// Mantém a precisão do domínio independente da configuração global.
const Decimal = DecimalJs.clone({ precision: 40 });
type Decimal = DecimalJs;

export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const INPUT_AMOUNT = /^\d+(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_DATABASE_AMOUNT = new Decimal('999999999999999999.99');

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    if (typeof amount !== 'string' || !INPUT_AMOUNT.test(amount)) {
      throw new InvalidMoneyError(`Invalid amount: "${String(amount)}"`);
    }
    Money.assertCurrency(currency);
    return Money.create(new Decimal(amount), currency);
  }

  // Dados persistidos podem ser negativos; entradas externas não.
  static fromPersisted(props: MoneyProps): Money {
    Money.assertCurrency(props.currency);
    let value: Decimal;
    try {
      value = new Decimal(props.amount);
    } catch {
      throw new InvalidMoneyError(`Invalid persisted amount: "${props.amount}"`);
    }
    if (!value.isFinite()) {
      throw new InvalidMoneyError(`Invalid persisted amount: "${props.amount}"`);
    }
    return Money.create(value, props.currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return Money.create(new Decimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.create(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.create(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.create(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: string): void {
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency: "${String(currency)}"`);
    }
  }

  private static create(value: Decimal, currency: string): Money {
    if (value.abs().greaterThan(MAX_DATABASE_AMOUNT)) {
      throw new InvalidMoneyError('Amount exceeds the database limit for numeric(20,2)');
    }
    return new Money(value, currency);
  }
}
