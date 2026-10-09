import type { SessionUser } from '@planning/contracts';
export type User = SessionUser;
export type Role = User['role'];
export type Status = User['status'];
export interface AuthConfig {
  appName: string; mode: 'ENTRA' | 'TEST_USER';
  tenantId?: string; clientId?: string; scope?: string; redirectUri?: string;
}
export type UserChange = { action: 'approve' | 'reject' | 'disable' | 'enable' } | { action: 'role'; role: Role };
