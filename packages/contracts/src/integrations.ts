import type { Capability } from './application.js';

export type ApiKeyStatus = 'ACTIVE' | 'SCHEDULED_REVOCATION' | 'REVOKED' | 'EXPIRED' | 'DISABLED';
export interface ApiKeySummary {
  id: string;
  integrationId: string;
  label: string;
  publicPrefix: string;
  capabilities: string[];
  effectiveCapabilities: Capability[];
  status: ApiKeyStatus;
  createdAt: string;
  expiresAt: string;
  effectiveExpiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdByUserId: string;
  revokedByUserId: string | null;
}
export interface IntegrationSummary {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string;
}
export interface IntegrationWithKeys extends IntegrationSummary { keys: ApiKeySummary[] }
export interface IntegrationListing {
  integrations: IntegrationWithKeys[];
  total: number;
  page: number;
  pageSize: 50;
}
// Plaintext appears only in these successful one-time responses.
export interface KeyCreatedResponse { key: ApiKeySummary; secret: string }
export interface KeyRotatedResponse extends KeyCreatedResponse { previousKeyRevokesAt: string }
