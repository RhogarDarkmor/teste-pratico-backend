import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors/money.errors';
import { Money } from '../../src/domain/money/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('criação', () => {
    test('serializa sempre com 2 casas', () => {
      expect(brl('25').toString()).toBe('25.00');
      expect(brl('25.5').toString()).toBe('25.50');
      expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    });

    test.each(['', ' ', 'abc', 'NaN', 'Infinity', '1e3', '1E3', '-1.00', '+1.00', '1.001', '1,00', '.5', '1.'])(
      'rejeita entrada inválida: "%s"',
      (amount) => {
        expect(() => brl(amount)).toThrow(InvalidMoneyError);
      },
    );

    test('rejeita amount que não seja string', () => {
      expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    test('rejeita moeda inválida', () => {
      expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '1.00', currency: '' })).toThrow(InvalidMoneyError);
    });
  });

  describe('aritmética', () => {
    test('não sofre dos erros de ponto flutuante', () => {
      expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    });

    test('soma e subtrai sem mutar os operandos', () => {
      const a = brl('100.00');
      const b = brl('80.00');
      expect(a.subtract(b).toString()).toBe('20.00');
      expect(a.add(b).toString()).toBe('180.00');
      expect(a.toString()).toBe('100.00');
      expect(b.toString()).toBe('80.00');
    });

    test('subtração pode resultar em negativo (o saldo é quem proíbe, não o Money)', () => {
      const result = brl('20.00').subtract(brl('80.00'));
      expect(result.isNegative()).toBe(true);
      expect(result.toString()).toBe('-60.00');
    });

    test('negate inverte o sinal', () => {
      expect(brl('5.00').negate().toString()).toBe('-5.00');
      expect(brl('5.00').negate().negate().equals(brl('5.00'))).toBe(true);
    });

    test('respeita o limite numeric(20,2) do banco', () => {
      const big = brl('999999999999999999.99');
      expect(big.toString()).toBe('999999999999999999.99');
      expect(() => brl('1000000000000000000.00')).toThrow(InvalidMoneyError);
      expect(() => big.add(brl('0.01'))).toThrow(InvalidMoneyError);
    });
  });

  describe('consultas', () => {
    test('isZero / isPositive / isNegative', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
      expect(Money.zero('BRL').isPositive()).toBe(false);
      expect(Money.zero('BRL').isNegative()).toBe(false);
      expect(Money.zero('BRL').negate().isNegative()).toBe(false);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.01').negate().isNegative()).toBe(true);
    });

    test('isLessThan e equals', () => {
      expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
      expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
      expect(brl('1.00').equals(brl('1'))).toBe(true);
      expect(brl('1.00').equals(brl('1.01'))).toBe(false);
    });
  });

  describe('moedas diferentes', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    test('add, subtract e isLessThan lançam erro de domínio', () => {
      expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    });

    test('equals simplesmente retorna false', () => {
      expect(brl('1.00').equals(usd)).toBe(false);
    });
  });

  describe('fromPersisted', () => {
    test('reidrata valores negativos e com escala do banco (numeric)', () => {
      expect(Money.fromPersisted({ amount: '-3.5000', currency: 'BRL' }).toString()).toBe('-3.50');
    });

    test('rejeita lixo mesmo vindo do banco', () => {
      expect(() => Money.fromPersisted({ amount: 'abc', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.fromPersisted({ amount: 'Infinity', currency: 'BRL' })).toThrow(InvalidMoneyError);
    });
  });
});
