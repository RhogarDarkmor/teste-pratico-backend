import { Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { OpenWalletUseCase } from '../application/open-wallet.use-case';
import { QueryWalletsUseCase } from '../application/query-wallets.use-case';
import { SubmitWagerTransactionUseCase } from '../application/submit-wager-transaction.use-case';
import { WageringController } from './wagering.controller';

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: OpenWalletUseCase,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new OpenWalletUseCase(em),
    },
    {
      provide: SubmitWagerTransactionUseCase,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new SubmitWagerTransactionUseCase(em),
    },
    {
      provide: QueryWalletsUseCase,
      inject: [EntityManager],
      useFactory: (em: EntityManager) => new QueryWalletsUseCase(em),
    },
  ],
  exports: [SubmitWagerTransactionUseCase],
})
export class WageringModule {}
