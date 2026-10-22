import { expect, test, mock } from 'bun:test';
import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { ApiExceptionFilter } from '../../src/http/api-exception.filter';

test('erro temporário de conexão com o banco vira 503', () => {
  const json = mock(() => undefined);
  const status = mock(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status, json }) }),
  } as unknown as ArgumentsHost;
  const cause = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
  const error = Object.assign(new Error('database request failed'), { cause });

  new ApiExceptionFilter().catch(error, host);

  expect(status).toHaveBeenCalledWith(503);
  expect(json).toHaveBeenCalledWith({
    statusCode: 503,
    code: 'TEMPORARY_INFRASTRUCTURE_FAILURE',
    message: 'The request can be retried',
  });
});

test('todo 400 sai com code, mesmo os do Nest', () => {
  const json = mock(() => undefined);
  const status = mock(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status, json }) }),
  } as unknown as ArgumentsHost;
  const filter = new ApiExceptionFilter();

  filter.catch(new BadRequestException('kind is not supported'), host);
  expect(json).toHaveBeenLastCalledWith({ statusCode: 400, code: 'INVALID_PAYLOAD', message: 'kind is not supported' });

  filter.catch(new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'missing' }), host);
  expect(json).toHaveBeenLastCalledWith({ statusCode: 400, code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'missing' });
});
