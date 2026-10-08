export const CAPABILITIES = [
  'call-for-sites.read', 'call-for-sites.search', 'call-for-sites.submit', 'call-for-sites.export',
  'call-for-sites.delete', 'users.manage', 'integrations.manage', 'audit.read',
] as const;
export type Capability = typeof CAPABILITIES[number];

export const ROLE_CAPABILITIES: Record<'USER' | 'ADMIN', readonly Capability[]> = {
  USER: ['call-for-sites.read', 'call-for-sites.search', 'call-for-sites.submit', 'call-for-sites.export'],
  ADMIN: CAPABILITIES,
};

export interface ModuleRoute {
  id: 'browse' | 'search' | 'record' | 'upload' | 'delete';
  path: string;
  label: string;
  description: string;
  capability: Capability;
}

export interface ModuleDefinition {
  id: 'call-for-sites';
  label: string;
  path: string;
  apiPath: string;
  capabilities: readonly Capability[];
  integrationSafeCapabilities: readonly Capability[];
  routes: readonly ModuleRoute[];
}

export const CALL_FOR_SITES_MODULE = {
  id: 'call-for-sites', label: 'Call for Sites', path: '/call-for-sites', apiPath: '/api/v1/call-for-sites',
  capabilities: ['call-for-sites.read', 'call-for-sites.search', 'call-for-sites.submit', 'call-for-sites.export', 'call-for-sites.delete'],
  integrationSafeCapabilities: ['call-for-sites.submit'],
  routes: [
    { id: 'browse', path: '/call-for-sites', label: 'Browse submissions', description: 'View received Call for Sites submissions.', capability: 'call-for-sites.read' },
    { id: 'search', path: '/call-for-sites/search', label: 'Search submissions', description: 'Find submissions by text and date received.', capability: 'call-for-sites.search' },
    { id: 'record', path: '/call-for-sites/records/:id', label: 'Submission details', description: 'Review a Call for Sites submission.', capability: 'call-for-sites.read' },
    { id: 'upload', path: '/call-for-sites/upload', label: 'Upload files', description: 'Submit JSON files or ZIP archives.', capability: 'call-for-sites.submit' },
    { id: 'delete', path: '/call-for-sites/delete', label: 'Delete a submission', description: 'Look up a submission for permanent deletion.', capability: 'call-for-sites.delete' },
  ],
} as const satisfies ModuleDefinition;

export const MODULE_REGISTRY: readonly ModuleDefinition[] = [CALL_FOR_SITES_MODULE];

export const ADMIN_ROUTES = [
  { path: '/admin/users', label: 'Users', description: 'Review accounts and manage access.', capability: 'users.manage' },
  { path: '/admin/integrations', label: 'Integrations', description: 'Manage named integrations and submission keys.', capability: 'integrations.manage' },
  { path: '/admin/audit', label: 'Audit', description: 'Review recorded application activity.', capability: 'audit.read' },
] as const satisfies readonly { path: string; label: string; description: string; capability: Capability }[];

export interface PublicLimits {
  ingestionMaxBodyBytes: number;
  uploadMaxFileBytes: number;
  zipMaxEntries: number;
  jsonMaxDepth: number;
  geojsonMaxPositions: number;
  exportMaxSelection: number;
  exportMaxBytes: number;
  exportGenerationTimeoutMs: number;
  exportDownloadTimeoutMs: number;
  idempotencyRetentionDays: number;
  apiKeyDefaultExpiryDays: number;
  apiKeyMaxExpiryDays: number;
}

export interface AppConfig {
  appName: string;
  businessTimezone: string;
  enabledModules: readonly ModuleDefinition[];
  limits: PublicLimits;
}
