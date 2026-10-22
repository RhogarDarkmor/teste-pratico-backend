import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  // Deliberately allows requests until an external provider identity is configured.
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
