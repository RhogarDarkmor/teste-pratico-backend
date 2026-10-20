import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  // Só diz que o processo está de pé. O /ready (Postgres + SQS) entra quando houver infra conectada.
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
