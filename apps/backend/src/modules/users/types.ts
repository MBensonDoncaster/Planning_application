export type Role = 'USER' | 'ADMIN';
export type Status = 'PENDING' | 'APPROVED' | 'REJECTED' | 'DISABLED';
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
  authenticate(identity: Identity): Promise<User>;
  list(query: { page: number; pageSize: number; search: string; status?: Status }): Promise<{ users: User[]; total: number }>;
  change(actorId: string, targetId: string, change: UserChange): Promise<User>;
  ready(): Promise<void>;
  close(): Promise<void>;
}
