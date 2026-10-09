import type { User, UserChange } from './types.js';
import { AppError } from '../../shared/errors.js';
import { requireApprovedUser, requireCapability } from '../../shared/actors.js';
export { AppError } from '../../shared/errors.js';

export function requireApproved(user: User): void {
  requireApprovedUser(user);
}

export function requireAdmin(user: User): void {
  requireCapability({ type: 'USER', user }, 'users.manage');
}

export function applyChange(target: User, change: UserChange, approvedAdmins: number, actorId: string): Partial<User> {
  const patch: Partial<User> = {};
  if (change.action === 'role') patch.role = change.role;
  else {
    const transitions = {
      approve: { from: ['PENDING'], to: 'APPROVED' },
      reject: { from: ['PENDING'], to: 'REJECTED' },
      disable: { from: ['APPROVED'], to: 'DISABLED' },
      enable: { from: ['DISABLED', 'REJECTED'], to: 'PENDING' },
    } as const;
    const transition = transitions[change.action];
    if (!(transition.from as readonly string[]).includes(target.status)) {
      throw new AppError(409, 'INVALID_TRANSITION', 'This action is not available for the current account status.');
    }
    patch.status = transition.to;
    if (change.action === 'approve') {
      patch.approvedAt = new Date();
      patch.approvedByUserId = actorId;
    } else {
      patch.approvedAt = null;
      patch.approvedByUserId = null;
    }
  }
  if (target.role === 'ADMIN' && target.status === 'APPROVED' && approvedAdmins <= 1 &&
      ((patch.role !== undefined && patch.role !== 'ADMIN') || (patch.status !== undefined && patch.status !== 'APPROVED'))) {
    throw new AppError(409, 'LAST_APPROVED_ADMIN', 'The last approved administrator cannot be disabled or demoted.');
  }
  return patch;
}
