import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OpenWalletUseCase } from '../application/open-wallet.use-case';
import { QueryWalletsUseCase } from '../application/query-wallets.use-case';
import { SubmitWagerTransactionUseCase, type SubmitWagerCommand } from '../application/submit-wager-transaction.use-case';
import { WagerTransactionKind } from '../domain/wagering/wager-transaction';

type JsonObject = Record<string, unknown>;

@Controller()
export class WageringController {
  private readonly logger = new Logger(WageringController.name);

  constructor(
    private readonly openWallet: OpenWalletUseCase,
    private readonly submitTransaction: SubmitWagerTransactionUseCase,
    private readonly queries: QueryWalletsUseCase,
  ) {}

  @Post('wallets')
  async createWallet(@Body() body: unknown) {
    const input = object(body, 'body');
    const initialBalance = object(input.initialBalance, 'initialBalance');
    const wallet = await this.openWallet.execute({
      playerId: string(input.playerId, 'playerId'),
      currency: string(initialBalance.currency, 'initialBalance.currency'),
      initialBalance: string(initialBalance.amount, 'initialBalance.amount'),
    });
    return {
      id: wallet.walletId,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: 1,
    };
  }

  @Get('wallets/:walletId')
  async getWallet(@Param('walletId') walletId: string) {
    assertUuid(walletId, 'walletId');
    const wallet = await this.queries.getWallet(walletId);
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  @Get('wallets/:walletId/ledger')
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    assertUuid(walletId, 'walletId');
    const result = await this.queries.getLedger(walletId, cursor, limit);
    return {
      walletId: result.walletId,
      entries: result.entries.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    };
  }

  @Get('wagering/transactions/:transactionId')
  async getTransaction(@Param('transactionId') transactionId: string) {
    assertUuid(transactionId, 'transactionId');
    return transactionJson(await this.queries.getTransaction(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getProviderTransaction(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return transactionJson(await this.queries.getProviderTransaction(providerId, externalTransactionId));
  }

  @Post('wagering/transactions')
  async submit(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey?: string) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key header is required' });
    }
    const command = wagerCommand(object(body, 'body'), idempotencyKey);
    const result = await this.submitTransaction.execute(command);
    const response = {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance.toJSON(),
      ...(result.failureCode && { failureCode: result.failureCode }),
      idempotentReplay: result.idempotentReplay,
    };
    if (result.status === 'REJECTED') {
      throw new UnprocessableEntityException(response);
    }
    if (result.status === 'PENDING_REFERENCE') {
      throw new HttpException(response, HttpStatus.ACCEPTED);
    }
    return response;
  }

  @Post('wallets/:walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string) {
    assertUuid(walletId, 'walletId');
    const result = await this.queries.reconcile(walletId);
    if (!result.consistent) {
      this.logger.error(
        `Wallet reconciliation mismatch for ${walletId}: stored=${result.storedBalance} calculated=${result.calculatedBalance}`,
      );
    }
    return {
      walletId: result.walletId,
      storedBalance: result.storedBalance.toJSON(),
      calculatedBalance: result.calculatedBalance.toJSON(),
      difference: result.difference.toJSON(),
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
    };
  }
}

function object(value: unknown, name: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException(`${name} must be an object`);
  }
  return value as JsonObject;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`${name} must be a non-empty string`);
  }
  return value;
}

function wagerCommand(body: JsonObject, idempotencyKey: string): SubmitWagerCommand {
  const money = object(body.money, 'money');
  const kind = string(body.kind, 'kind');
  const validKinds = [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ];
  if (!validKinds.includes(kind as WagerTransactionKind)) {
    throw new BadRequestException('kind is not supported');
  }
  const reference = body.referenceExternalTransactionId;
  if (reference !== undefined && (typeof reference !== 'string' || reference.trim() === '')) {
    throw new BadRequestException('referenceExternalTransactionId must be a non-empty string');
  }
  return {
    providerId: string(body.providerId, 'providerId'),
    externalTransactionId: string(body.externalTransactionId, 'externalTransactionId'),
    idempotencyKey,
    walletId: string(body.walletId, 'walletId'),
    playerId: string(body.playerId, 'playerId'),
    roundId: string(body.roundId, 'roundId'),
    gameId: string(body.gameId, 'gameId'),
    kind: kind as WagerTransactionKind,
    amount: string(money.amount, 'money.amount'),
    currency: string(money.currency, 'money.currency'),
    ...(reference !== undefined && { referenceExternalTransactionId: reference }),
  };
}

function assertUuid(value: string, name: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${name} must be a UUID`);
  }
}

function transactionJson(transaction: Awaited<ReturnType<QueryWalletsUseCase['getTransaction']>>) {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}
