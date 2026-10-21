import { expect, test, mock } from 'bun:test';
import type { ArgumentsHost } from '@nestjs/common';
import { ApiExceptionFilter } from '../../src/http/api-exception.filter';

test('temporary database connection errors return 503', () => {
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
