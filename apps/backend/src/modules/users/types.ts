import type { UserRole, UserStatus } from '@planning/contracts';
import type { AuditContext } from '../../shared/audit.js';
export type Role = UserRole;
export type Status = UserStatus;
export interface Identity { subject: string; email: string; displayName: string }
export interface User extends Identity {
  id: string;
  role: Role;
  status: Status;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  approvedAt: Date | null;
  approvedByUserId: string | null;
}
export type UserChange = { action: 'approve' | 'reject' | 'disable' | 'enable' } | { action: 'role'; role: Role };
export interface UserRepository {
  authenticate(identity: Identity, auditContext?: AuditContext): Promise<User>;
  findBySubject(subject: string): Promise<User | null>;
  list(query: { page: number; pageSize: number; search: string; status?: Status }): Promise<{ users: User[]; total: number }>;
  change(actorId: string, targetId: string, change: UserChange, auditContext?: AuditContext): Promise<User>;
  ready(): Promise<void>;
  close(): Promise<void>;
}
