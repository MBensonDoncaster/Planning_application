export type Role = 'USER' | 'ADMIN';
export type Status = 'PENDING' | 'APPROVED' | 'REJECTED' | 'DISABLED';
export interface User {
  id: string; subject: string; email: string; displayName: string;
  role: Role; status: Status; createdAt: string; updatedAt: string;
  lastLoginAt: string | null; approvedAt: string | null; approvedByUserId: string | null;
}
export interface AuthConfig {
  appName: string; mode: 'ENTRA' | 'TEST_USER';
  tenantId?: string; clientId?: string; scope?: string; redirectUri?: string;
}
export type UserChange = { action: 'approve' | 'reject' | 'disable' | 'enable' } | { action: 'role'; role: Role };
