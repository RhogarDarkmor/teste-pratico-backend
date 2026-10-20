import { DomainError } from './domain-error';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export class InvalidMovementError extends DomainError {
  readonly code = 'INVALID_MOVEMENT';
}

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = 'UNBALANCED_LEDGER_ENTRY';
}
