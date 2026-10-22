import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  // autenticação ainda não implementada, ver ARCHITECTURE.md
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
