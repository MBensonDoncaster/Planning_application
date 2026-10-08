import { MODULE_REGISTRY, type AppConfig } from '@planning/contracts';
import type { Config } from './env.js';

export function publicAppConfig(config: Config): AppConfig {
  return {
    appName: config.APP_NAME,
    businessTimezone: config.BUSINESS_TIMEZONE,
    enabledModules: MODULE_REGISTRY,
    limits: {
      ingestionMaxBodyBytes: config.INGESTION_MAX_BODY_BYTES,
      uploadMaxFileBytes: config.UPLOAD_MAX_FILE_BYTES,
      zipMaxEntries: config.ZIP_MAX_ENTRIES,
      jsonMaxDepth: config.JSON_MAX_DEPTH,
      geojsonMaxPositions: config.GEOJSON_MAX_POSITIONS,
      exportMaxSelection: config.EXPORT_MAX_SELECTION,
      exportMaxBytes: config.EXPORT_MAX_BYTES,
      exportGenerationTimeoutMs: config.EXPORT_GENERATION_TIMEOUT_MS,
      exportDownloadTimeoutMs: config.EXPORT_DOWNLOAD_TIMEOUT_MS,
      idempotencyRetentionDays: config.IDEMPOTENCY_RETENTION_DAYS,
      apiKeyDefaultExpiryDays: config.API_KEY_DEFAULT_EXPIRY_DAYS,
      apiKeyMaxExpiryDays: config.API_KEY_MAX_EXPIRY_DAYS,
    },
  };
}
