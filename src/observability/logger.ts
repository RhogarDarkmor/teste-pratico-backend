import type { LoggerService } from '@nestjs/common';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

type Sink = (line: string) => void;

const stdout: Sink = (text) => {
  process.stdout.write(`${text}\n`);
};

let sink: Sink = stdout;


export function setLogSink(next: Sink | undefined): void {
  sink = next ?? stdout;
}

const silent = () => process.env.NODE_ENV === 'test' && sink === stdout;

// nunca vão pro log: valores financeiros e payload inteiro
const FORBIDDEN = new Set(['amount', 'balance', 'money', 'payload', 'body', 'initialBalance']);

function write(level: LogLevel, context: string | undefined, message: unknown, extra?: LogFields): void {
  if (silent()) return;
  const fields: LogFields =
    typeof message === 'object' && message !== null ? { ...(message as LogFields) } : { message: String(message) };
  const entry: LogFields = { timestamp: new Date().toISOString(), level, ...(context && { context }), ...fields, ...extra };
  for (const key of Object.keys(entry)) {
    if (FORBIDDEN.has(key)) delete entry[key];
  }
  sink(JSON.stringify(entry));
}

export interface AppLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export function createLogger(context: string): AppLogger {
  return {
    info: (message, fields) => write('info', context, { message, ...fields }),
    warn: (message, fields) => write('warn', context, { message, ...fields }),
    error: (message, fields) => write('error', context, { message, ...fields }),
  };
}

export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    write('info', context, message);
  }
  warn(message: unknown, context?: string): void {
    write('warn', context, message);
  }
  error(message: unknown, ...rest: unknown[]): void {
    const last = rest.at(-1);
    const context = typeof last === 'string' ? last : undefined;
    const stack = typeof rest[0] === 'string' && rest.length > 1 ? rest[0] : undefined;
    write('error', context, message, stack ? { stack } : undefined);
  }
  debug(message: unknown, context?: string): void {
    write('debug', context, message);
  }
  verbose(message: unknown, context?: string): void {
    write('debug', context, message);
  }
}
