export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  AlreadyReversed = 'ALREADY_REVERSED',
  InternalError = 'INTERNAL_ERROR',
}
