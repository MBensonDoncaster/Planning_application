import type { Capability } from '@planning/contracts';
import type { User } from '../types';

export function canAccess(user: User | undefined, capabilities: readonly Capability[], capability: Capability): boolean {
  return user?.status === 'APPROVED' && capabilities.includes(capability);
}
