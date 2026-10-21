import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JsonLogger } from './observability/logger';
import { httpObservability } from './observability/http-observability';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
  app.use(httpObservability);
  // deixa o SIGTERM encerrar direito
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`listening on :${port}`);
}

bootstrap();
