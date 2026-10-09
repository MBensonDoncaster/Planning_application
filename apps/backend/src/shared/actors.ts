import { MODULE_REGISTRY, ROLE_CAPABILITIES, type Capability } from '@planning/contracts';
import type { User } from '../modules/users/types.js';
import { AppError } from './errors.js';

export interface UserActor { type: 'USER'; user: User }
// Integration authentication supplies these IDs/scopes after validating current key state.
export interface IntegrationActor {
  type: 'INTEGRATION';
  integrationId: string;
  keyId: string;
  capabilities: readonly Capability[];
}
// Internal jobs receive explicit capabilities; SYSTEM never implies administrator access.
export interface SystemActor { type: 'SYSTEM'; name: string; capabilities: readonly Capability[] }
export type Actor = UserActor | IntegrationActor | SystemActor;

export function capabilitiesForActor(actor: Actor): readonly Capability[] {
  if (actor.type === 'USER') return actor.user.status === 'APPROVED' ? [...ROLE_CAPABILITIES[actor.user.role]] : [];
  if (actor.type === 'INTEGRATION') {
    const safe = MODULE_REGISTRY.flatMap(module => module.integrationSafeCapabilities);
    return [...new Set(actor.capabilities.filter(capability => safe.includes(capability)))];
  }
  return [...new Set(actor.capabilities)];
}

export function requireApprovedUser(user: User): void {
  if (user.status !== 'APPROVED') {
    throw new AppError(403, user.status === 'DISABLED' ? 'USER_DISABLED' : 'USER_NOT_APPROVED', 'Your account does not have approved access.');
  }
}

export function requireCapability(actor: Actor | null, capability: Capability): void {
  if (!actor) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue.');
  if (actor.type === 'USER') requireApprovedUser(actor.user);
  if (!capabilitiesForActor(actor).includes(capability)) {
    throw new AppError(403, 'FORBIDDEN', 'Your account does not have permission to use this function.');
  }
}
