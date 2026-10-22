import { DomainError } from '../domain/errors/domain-error';

export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}

export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

export class WagerTransactionNotFoundError extends DomainError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}

export class InvalidQueryError extends DomainError {
  readonly code = 'INVALID_QUERY';
}

export class InvalidMessageError extends DomainError {
  readonly code = 'INVALID_MESSAGE';
}
