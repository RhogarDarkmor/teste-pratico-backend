import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DomainError } from '../domain/errors/domain-error';
import { IdempotencyConflictError, WalletAlreadyExistsError, WalletNotFoundError, WagerTransactionNotFoundError } from '../application/errors';

const TRANSIENT_DATABASE_CODES = new Set([
  '40001',
  '40P01',
  '08000',
  '08001',
  '08003',
  '08006',
  '53300',
  '57P01',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);
type HttpResponse = { status: (code: number) => HttpResponse; json: (body: unknown) => void };

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (exception instanceof WalletAlreadyExistsError || exception instanceof IdempotencyConflictError) {
      response.status(HttpStatus.CONFLICT).json({ statusCode: 409, code: exception.code, message: exception.message });
      return;
    }

    if (exception instanceof WalletNotFoundError || exception instanceof WagerTransactionNotFoundError) {
      response.status(HttpStatus.NOT_FOUND).json({ statusCode: 404, code: exception.code, message: exception.message });
      return;
    }

    if (exception instanceof DomainError) {
      response.status(HttpStatus.BAD_REQUEST).json({ statusCode: 400, code: exception.code, message: exception.message });
      return;
    }

    const code = errorCode(exception);
    if (code && TRANSIENT_DATABASE_CODES.has(code)) {
      this.logger.warn(`Temporary database failure (${code})`);
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        statusCode: 503,
        code: 'TEMPORARY_INFRASTRUCTURE_FAILURE',
        message: 'The request can be retried',
      });
      return;
    }

    this.logger.error('Unhandled request failure', exception instanceof Error ? exception.stack : String(exception));
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  }
}

function errorCode(error: unknown, depth = 0): string | undefined {
  if (depth > 3 || typeof error !== 'object' || error === null) {
    return undefined;
  }
  if ('code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'cause' in error ? errorCode(error.cause, depth + 1) : undefined;
}
