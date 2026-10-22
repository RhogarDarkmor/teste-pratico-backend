import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { withRetry } from '../../src/infra/database/retry';
import { createLogger, JsonLogger, setLogSink } from '../../src/observability/logger';
import { Counter, Gauge, Histogram, metrics } from '../../src/observability/metrics';

let lines: Record<string, any>[] = [];

beforeEach(() => {
  metrics.reset();
  lines = [];
  setLogSink((line) => lines.push(JSON.parse(line)));
});

afterEach(() => setLogSink(undefined));

describe('logger', () => {
  test('escreve uma linha JSON com nível, contexto e campos', () => {
    createLogger('Teste').info('algo aconteceu', { walletId: 'w1', correlationId: 'c1' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', context: 'Teste', message: 'algo aconteceu', walletId: 'w1', correlationId: 'c1' });
    expect(new Date(lines[0]!.timestamp).toString()).not.toBe('Invalid Date');
  });

  test('descarta campos financeiros e payloads', () => {
    createLogger('Teste').info('x', { amount: '10.00', balance: '5', money: { amount: '1' }, payload: {}, body: {}, walletId: 'w1' });
    expect(Object.keys(lines[0]!).sort()).toEqual(['context', 'level', 'message', 'timestamp', 'walletId']);
  });

  test('o logger do Nest aceita texto, objeto e erro com stack', () => {
    const logger = new JsonLogger();
    logger.log('texto', 'Ctx');
    logger.warn({ message: 'objeto', messageId: 'm1' }, 'Ctx');
    logger.error('falhou', 'stack-trace', 'Ctx');
    expect(lines.map((l) => l.level)).toEqual(['info', 'warn', 'error']);
    expect(lines[1]).toMatchObject({ message: 'objeto', messageId: 'm1', context: 'Ctx' });
    expect(lines[2]).toMatchObject({ message: 'falhou', stack: 'stack-trace', context: 'Ctx' });
  });
});

describe('métricas', () => {
  test('counter com labels sai no formato prometheus', () => {
    const c = new Counter('demo_total', 'demo');
    c.inc({ a: 'x' });
    c.inc({ a: 'x' }, 2);
    expect(c.get({ a: 'x' })).toBe(3);
    expect(c.render()).toContain('demo_total{a="x"} 3');
  });

  test('histogram acumula buckets, soma e contagem', () => {
    const h = new Histogram('lat_seconds', 'demo', [0.1, 1]);
    h.observe(0.05);
    h.observe(0.5);
    const out = h.render();
    expect(out).toContain('lat_seconds_bucket{le="0.1"} 1');
    expect(out).toContain('lat_seconds_bucket{le="1"} 2');
    expect(out).toContain('lat_seconds_bucket{le="+Inf"} 2');
    expect(out).toContain('lat_seconds_count 2');
  });

  test('falha ao coletar gauge é registrada em log sem quebrar o scrape', async () => {
    const gauge = new Gauge('db_gauge', 'database gauge', async () => {
      throw Object.assign(new Error('unavailable'), { code: 'ECONNREFUSED' });
    });

    expect(await gauge.render()).toEqual([
      '# HELP db_gauge database gauge',
      '# TYPE db_gauge gauge',
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'error',
      context: 'Metrics',
      message: 'Metric gauge collection failed',
      gauge: 'db_gauge',
      errorCode: 'ECONNREFUSED',
    });
  });

  test('retry de deadlock e serialização conta como conflito de lock; unique só como retry', async () => {
    let calls = 0;
    await withRetry(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('deadlock'), { code: '40P01' });
      if (calls === 2) throw Object.assign(new Error('unique'), { code: '23505' });
      return 'ok';
    });
    expect(metrics.dbRetries.total()).toBe(2);
    expect(metrics.lockConflicts.get({ code: '40P01' })).toBe(1);
    expect(metrics.lockConflicts.total()).toBe(1);
  });
});
