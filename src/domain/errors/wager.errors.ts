import { DomainError } from './domain-error';

export class InvalidWagerError extends DomainError {
  readonly code = 'INVALID_WAGER';
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}
