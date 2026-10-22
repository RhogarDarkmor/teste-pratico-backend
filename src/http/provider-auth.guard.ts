import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  // Autenticação ainda não está implementada.
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
