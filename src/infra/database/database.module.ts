import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { buildOrmConfig } from './orm.config';

@Module({
  imports: [MikroOrmModule.forRoot(buildOrmConfig())],
})
export class DatabaseModule {}
