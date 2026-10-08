import type { User, UserChange } from './types.js';

export class AppError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}

export function requireApproved(user: User): void {
  if (user.status !== 'APPROVED') throw new AppError(403, 'ACCESS_NOT_APPROVED', 'Your account does not have approved access.');
}

export function requireAdmin(user: User): void {
  requireApproved(user);
  if (user.role !== 'ADMIN') throw new AppError(403, 'ADMIN_REQUIRED', 'Administrator access is required.');
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
    throw new AppError(409, 'LAST_ADMIN', 'The last approved administrator cannot be disabled or demoted.');
  }
  return patch;
}
