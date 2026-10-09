import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, type Capability } from '@planning/contracts';
import { capabilitiesForActor, requireCapability, type Actor } from '../src/shared/actors.js';
import type { User } from '../src/modules/users/types.js';

const humanCapabilities: readonly Capability[] = ['call-for-sites.read', 'call-for-sites.search', 'call-for-sites.submit', 'call-for-sites.export'];
const user = (role: User['role'], status: User['status']): User => ({
  id: randomUUID(), subject: 'entra:synthetic:user', email: 'synthetic@example.test', displayName: 'Synthetic', role, status,
  createdAt: new Date(), updatedAt: new Date(), lastLoginAt: null, approvedAt: null, approvedByUserId: null,
});

describe('shared actor capabilities', () => {
  it.each((['USER', 'ADMIN'] as const).flatMap(role =>
    (['PENDING', 'APPROVED', 'REJECTED', 'DISABLED'] as const).map(status => ({ role, status }))))(
    'enforces every declared capability for $role/$status', ({ role, status }) => {
      const actor: Actor = { type: 'USER', user: user(role, status) };
      const expected = status !== 'APPROVED' ? [] : role === 'ADMIN' ? CAPABILITIES : humanCapabilities;
      expect(capabilitiesForActor(actor)).toEqual(expected);
      for (const capability of CAPABILITIES) {
        if (expected.includes(capability)) expect(() => requireCapability(actor, capability)).not.toThrow();
        else {
          try { requireCapability(actor, capability); throw new Error('Expected an access denial'); }
          catch (error) {
            expect(error).toMatchObject({ statusCode: 403, code: status === 'DISABLED' ? 'USER_DISABLED' : status !== 'APPROVED' ? 'USER_NOT_APPROVED' : 'FORBIDDEN' });
          }
        }
      }
    },
  );

  it('intersects integration grants with registered integration-safe capabilities', () => {
    const actor: Actor = { type: 'INTEGRATION', integrationId: randomUUID(), keyId: randomUUID(), capabilities: CAPABILITIES };
    expect(capabilitiesForActor(actor)).toEqual(['call-for-sites.submit']);
    expect(() => requireCapability(actor, 'call-for-sites.submit')).not.toThrow();
    for (const capability of CAPABILITIES.filter(capability => capability !== 'call-for-sites.submit')) {
      expect(() => requireCapability(actor, capability)).toThrow();
    }
    actor.capabilities = ['call-for-sites.read'];
    expect(capabilitiesForActor(actor)).toEqual([]);
    expect(() => requireCapability(actor, 'call-for-sites.submit')).toThrow();
  });

  it('gives system actors only their explicitly assigned capabilities', () => {
    const actor: Actor = { type: 'SYSTEM', name: 'synthetic-job', capabilities: [] };
    expect(capabilitiesForActor(actor)).toEqual([]);
    for (const capability of CAPABILITIES) expect(() => requireCapability(actor, capability)).toThrow();
    actor.capabilities = ['audit.read', 'audit.read'];
    expect(capabilitiesForActor(actor)).toEqual(['audit.read']);
    expect(() => requireCapability(actor, 'audit.read')).not.toThrow();
    expect(() => requireCapability(actor, 'users.manage')).toThrow();
  });

  it('rejects an unauthenticated actor and does not expose mutable registry state', () => {
    expect(() => requireCapability(null, 'call-for-sites.read')).toThrow();
    const actor: Actor = { type: 'USER', user: user('USER', 'APPROVED') };
    const capabilities = capabilitiesForActor(actor) as Capability[];
    capabilities.push('users.manage');
    expect(capabilitiesForActor(actor)).toEqual(humanCapabilities);
    expect(() => requireCapability(actor, 'users.manage')).toThrow();
  });
});
