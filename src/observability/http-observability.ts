import { newId } from '../shared/ids';
import { createLogger } from './logger';
import { metrics } from './metrics';

const logger = createLogger('http');

interface Req {
  method: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  route?: { path?: string };
}

interface Res {
  statusCode: number;
  setHeader(name: string, value: string): void;
  once(event: 'finish', listener: () => void): void;
}

export function httpObservability(req: Req, res: Res, next: () => void): void {
  const incoming = req.headers['x-correlation-id'];
  const correlationId = (Array.isArray(incoming) ? incoming[0] : incoming)?.trim() || newId();
  req.headers['x-correlation-id'] = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  const startedAt = performance.now();
  res.once('finish', () => {
    const seconds = (performance.now() - startedAt) / 1000;
    // usa o padrão da rota pra não explodir a cardinalidade com IDs
    const route = req.route?.path ?? 'unmatched';
    metrics.httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
    metrics.httpDuration.observe(seconds, { method: req.method, route });
    if (route !== '/health/live' && route !== '/metrics') {
      logger.info('request completed', {
        correlationId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round(seconds * 1000),
      });
    }
  });
  next();
}
