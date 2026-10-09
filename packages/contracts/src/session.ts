import type { Capability } from './application.js';

export type UserRole = 'USER' | 'ADMIN';
export type UserStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'DISABLED';

export interface SessionUser {
  id: string;
  subject: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  approvedAt: string | null;
  approvedByUserId: string | null;
}

export interface SessionResponse {
  user: SessionUser;
  capabilities: readonly Capability[];
}
