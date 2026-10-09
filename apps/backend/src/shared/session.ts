import type { SessionResponse } from '@planning/contracts';
import type { User } from '../modules/users/types.js';
import { capabilitiesForActor } from './actors.js';

export function sessionForUser(user: User): SessionResponse {
  return {
    user: {
      ...user,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      approvedAt: user.approvedAt?.toISOString() ?? null,
    },
    capabilities: capabilitiesForActor({ type: 'USER', user }),
  };
}
