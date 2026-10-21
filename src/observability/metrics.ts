type Labels = Record<string, string>;

const keyOf = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((name) => `${name}="${String(labels[name]).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',');

const line = (name: string, key: string, value: number) => `${name}${key ? `{${key}}` : ''} ${value}`;

export class Counter {
  private readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, amount = 1): void {
    const key = keyOf(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  get(labels: Labels = {}): number {
    return this.values.get(keyOf(labels)) ?? 0;
  }

  total(): number {
    let sum = 0;
    for (const value of this.values.values()) sum += value;
    return sum;
  }

  reset(): void {
    this.values.clear();
  }

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) out.push(line(this.name, key, value));
    return out;
  }
}

interface Series {
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram {
  private readonly series = new Map<string, Series>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly buckets: number[],
  ) {}

  observe(value: number, labels: Labels = {}): void {
    const key = keyOf(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    this.buckets.forEach((bound, i) => {
      if (value <= bound) s.counts[i]!++;
    });
    s.sum += value;
    s.count++;
  }

  count(labels: Labels = {}): number {
    return this.series.get(keyOf(labels))?.count ?? 0;
  }

  reset(): void {
    this.series.clear();
  }

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, s] of this.series) {
      const sep = key ? `${key},` : '';
      this.buckets.forEach((bound, i) => out.push(line(`${this.name}_bucket`, `${sep}le="${bound}"`, s.counts[i]!)));
      out.push(line(`${this.name}_bucket`, `${sep}le="+Inf"`, s.count));
      out.push(line(`${this.name}_sum`, key, s.sum));
      out.push(line(`${this.name}_count`, key, s.count));
    }
    return out;
  }
}

// Gauge calculado na hora da leitura (por exemplo, consultando o banco).
export class Gauge {
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly collect: () => Promise<number>,
  ) {}

  async render(): Promise<string[]> {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    try {
      out.push(line(this.name, '', await this.collect()));
    } catch {
      // se a consulta falhar o gauge some da leitura; o readiness é quem avisa do banco
    }
    return out;
  }
}

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export class MetricsRegistry {
  private readonly gauges = new Map<string, Gauge>();

  readonly transactions = new Counter('wagering_transactions_total', 'Transactions finished, by status and kind');
  readonly duplicates = new Counter('wagering_duplicates_total', 'Duplicates detected, by source (idempotency or inbox)');
  readonly dbRetries = new Counter('wagering_db_retries_total', 'Database retries, by SQLSTATE code');
  readonly lockConflicts = new Counter('wagering_lock_conflicts_total', 'Deadlocks and serialization failures');
  readonly processingDuration = new Histogram(
    'wagering_processing_duration_seconds',
    'Time to process a transaction, by origin',
    LATENCY_BUCKETS,
  );
  readonly httpRequests = new Counter('http_requests_total', 'HTTP requests, by method, route and status');
  readonly httpDuration = new Histogram('http_request_duration_seconds', 'HTTP latency, by method and route', LATENCY_BUCKETS);
  readonly sqsMessages = new Counter('sqs_messages_total', 'Input queue messages, by outcome');
  readonly sqsRetries = new Counter('sqs_message_retries_total', 'Input queue messages scheduled for another attempt');
  readonly dlqMessages = new Counter('sqs_dlq_messages_total', 'Messages sent to the DLQ, by failure kind');
  readonly outboxPublished = new Counter('outbox_published_total', 'Outbox messages published');
  readonly outboxFailures = new Counter('outbox_publish_failures_total', 'Outbox publish attempts that failed');
  readonly pendingReprocessed = new Counter('pending_reference_reprocessed_total', 'Pending reference reprocessing, by result');
  readonly reconciliations = new Counter('reconciliation_runs_total', 'Wallet reconciliations run');
  readonly reconciliationDivergences = new Counter(
    'reconciliation_divergences_total',
    'Reconciliations where stored balance differs from the ledger',
  );

  private get counters(): Counter[] {
    return [
      this.transactions,
      this.duplicates,
      this.dbRetries,
      this.lockConflicts,
      this.httpRequests,
      this.sqsMessages,
      this.sqsRetries,
      this.dlqMessages,
      this.outboxPublished,
      this.outboxFailures,
      this.pendingReprocessed,
      this.reconciliations,
      this.reconciliationDivergences,
    ];
  }

  // registrar de novo com o mesmo nome substitui (útil quando a aplicação sobe mais de uma vez no mesmo processo)
  registerGauge(gauge: Gauge): void {
    this.gauges.set(gauge.name, gauge);
  }

  reset(): void {
    for (const counter of this.counters) counter.reset();
    this.processingDuration.reset();
    this.httpDuration.reset();
  }

  async render(): Promise<string> {
    const out: string[] = [];
    for (const counter of this.counters) out.push(...counter.render());
    out.push(...this.processingDuration.render(), ...this.httpDuration.render());
    for (const gauge of this.gauges.values()) out.push(...(await gauge.render()));
    return `${out.join('\n')}\n`;
  }
}

export const metrics = new MetricsRegistry();
