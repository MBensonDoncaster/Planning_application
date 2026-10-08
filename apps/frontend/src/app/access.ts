import { ROLE_CAPABILITIES, type Capability } from '@planning/contracts';
import type { User } from '../types';

export function canAccess(user: User | undefined, capability: Capability): boolean {
  return user?.status === 'APPROVED' && ROLE_CAPABILITIES[user.role].includes(capability);
}
