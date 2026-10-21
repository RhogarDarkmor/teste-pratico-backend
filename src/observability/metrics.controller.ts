import { Controller, Get, Header, Inject } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Gauge, metrics } from './metrics';

// Os gauges consultam o banco na hora da leitura: o estado vem do Postgres, não de memória da instância.
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {
    const scalar = async (sql: string): Promise<number> => {
      const rows = await this.em.fork().execute(sql);
      return Number(rows[0]?.value ?? 0);
    };
    metrics.registerGauge(
      new Gauge('outbox_lag_seconds', 'Age of the oldest unpublished outbox message', () =>
        scalar(
          `select coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as value
             from outbox_messages where published_at is null`,
        ),
      ),
    );
    metrics.registerGauge(
      new Gauge('outbox_pending_messages', 'Outbox messages waiting to be published', () =>
        scalar(`select count(*)::int as value from outbox_messages where published_at is null`),
      ),
    );
    metrics.registerGauge(
      new Gauge('pending_reference_transactions', 'Transactions waiting for their reference', () =>
        scalar(`select count(*)::int as value from wager_transactions where status = 'PENDING_REFERENCE'`),
      ),
    );
  }

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render(): Promise<string> {
    return metrics.render();
  }
}
