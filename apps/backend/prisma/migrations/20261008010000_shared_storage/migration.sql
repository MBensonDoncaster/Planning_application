CREATE TYPE "ActorType" AS ENUM ('USER', 'INTEGRATION', 'SYSTEM', 'UNKNOWN');
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');
CREATE TYPE "IngestionChannel" AS ENUM ('FILE_JSON', 'FILE_ZIP', 'PASTE', 'INTEGRATION_API');
CREATE TYPE "IdempotencyActorType" AS ENUM ('USER', 'INTEGRATION');
CREATE TYPE "RateLimitScope" AS ENUM ('USER', 'USER_WRITE', 'API_KEY', 'INTEGRATION_IP');

CREATE TABLE "integrations" (
  "id" UUID PRIMARY KEY,
  "name" TEXT NOT NULL CHECK (length(btrim("name")) > 0),
  "description" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "integrations_active_name_key" ON "integrations" ("name") WHERE "enabled";

CREATE TABLE "api_keys" (
  "id" UUID PRIMARY KEY,
  "integration_id" UUID NOT NULL REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "label" TEXT NOT NULL CHECK (length(btrim("label")) > 0),
  "public_prefix" TEXT NOT NULL CHECK (length(btrim("public_prefix")) > 0),
  "secret_digest" TEXT NOT NULL CHECK ("secret_digest" ~ '^[a-f0-9]{64}$'),
  "capabilities" TEXT[] NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3),
  "last_used_at" TIMESTAMPTZ(3),
  "created_by_user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "revoked_by_user_id" UUID REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "api_keys_capabilities_check" CHECK (
    cardinality("capabilities") > 0 AND array_position("capabilities", NULL) IS NULL
    AND "capabilities" <@ ARRAY['call-for-sites.submit']::TEXT[]
  ),
  CONSTRAINT "api_keys_expiry_check" CHECK (
    "expires_at" > "created_at" AND EXTRACT(EPOCH FROM ("expires_at" - "created_at")) <= 31536000
  ),
  CONSTRAINT "api_keys_revocation_check" CHECK (
    ("revoked_at" IS NULL AND "revoked_by_user_id" IS NULL)
    OR ("revoked_at" IS NOT NULL AND "revoked_at" >= "created_at" AND "revoked_by_user_id" IS NOT NULL)
  ),
  CONSTRAINT "api_keys_last_use_check" CHECK ("last_used_at" IS NULL OR "last_used_at" >= "created_at")
);
CREATE UNIQUE INDEX "api_keys_public_prefix_key" ON "api_keys" ("public_prefix");
CREATE UNIQUE INDEX "api_keys_secret_digest_key" ON "api_keys" ("secret_digest");
CREATE INDEX "api_keys_integration_created_idx" ON "api_keys" ("integration_id", "created_at" DESC, "id" DESC);

CREATE TABLE "audit_events" (
  "id" UUID PRIMARY KEY,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "request_id" TEXT NOT NULL CHECK (length(btrim("request_id")) > 0),
  "actor_type" "ActorType" NOT NULL,
  "actor_user_id" UUID,
  "actor_integration_id" UUID,
  "actor_key_id" UUID,
  "module" TEXT NOT NULL CHECK (length(btrim("module")) > 0),
  "action" TEXT NOT NULL CHECK (length(btrim("action")) > 0),
  "target_type" TEXT,
  "target_id" UUID,
  "outcome" "AuditOutcome" NOT NULL,
  "error_code" TEXT,
  "channel" "IngestionChannel",
  "metadata" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "audit_events_actor_check" CHECK (
    ("actor_type" = 'USER' AND "actor_user_id" IS NOT NULL AND "actor_integration_id" IS NULL AND "actor_key_id" IS NULL)
    OR ("actor_type" = 'INTEGRATION' AND "actor_user_id" IS NULL AND "actor_integration_id" IS NOT NULL AND "actor_key_id" IS NOT NULL)
    OR ("actor_type" IN ('SYSTEM', 'UNKNOWN') AND "actor_user_id" IS NULL AND "actor_integration_id" IS NULL AND "actor_key_id" IS NULL)
  ),
  CONSTRAINT "audit_events_target_check" CHECK ("target_id" IS NULL OR "target_type" IS NOT NULL),
  CONSTRAINT "audit_events_metadata_check" CHECK (jsonb_typeof("metadata") = 'object' AND octet_length("metadata"::TEXT) <= 65536)
);
-- Runtime grants are applied explicitly by the database operator; no blanket grants.
REVOKE ALL ON TABLE "audit_events" FROM PUBLIC;
CREATE INDEX "audit_events_order_idx" ON "audit_events" ("occurred_at" DESC, "id" DESC);
CREATE INDEX "audit_events_user_idx" ON "audit_events" ("actor_user_id", "occurred_at" DESC);
CREATE INDEX "audit_events_integration_idx" ON "audit_events" ("actor_integration_id", "occurred_at" DESC);
CREATE INDEX "audit_events_key_idx" ON "audit_events" ("actor_key_id", "occurred_at" DESC);
CREATE INDEX "audit_events_filter_idx" ON "audit_events" ("module", "action", "outcome", "occurred_at" DESC);
CREATE INDEX "audit_events_target_idx" ON "audit_events" ("target_id", "occurred_at" DESC);

CREATE TABLE "idempotency_records" (
  "id" UUID PRIMARY KEY,
  "actor_type" "IdempotencyActorType" NOT NULL,
  "actor_id" UUID NOT NULL,
  "operation" TEXT NOT NULL CHECK (length(btrim("operation")) > 0),
  "key" UUID NOT NULL CHECK (substring("key"::TEXT, 15, 1) = '4' AND substring("key"::TEXT, 20, 1) IN ('8', '9', 'a', 'b')),
  "payload_digest" TEXT NOT NULL CHECK ("payload_digest" ~ '^[a-f0-9]{64}$'),
  "submission_id" UUID NOT NULL,
  "response" JSONB NOT NULL CHECK (jsonb_typeof("response") = 'object'),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "deleted_at" TIMESTAMPTZ(3),
  CONSTRAINT "idempotency_records_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "idempotency_records_deletion_check" CHECK ("deleted_at" IS NULL OR "deleted_at" >= "created_at")
);
CREATE UNIQUE INDEX "idempotency_records_namespace_key" ON "idempotency_records" ("actor_type", "actor_id", "operation", "key");
CREATE INDEX "idempotency_records_expiry_idx" ON "idempotency_records" ("expires_at");
CREATE INDEX "idempotency_records_submission_idx" ON "idempotency_records" ("submission_id");

CREATE TABLE "rate_limit_buckets" (
  "scope" "RateLimitScope" NOT NULL,
  "subject_digest" TEXT NOT NULL CHECK ("subject_digest" ~ '^[a-f0-9]{64}$'),
  "window_start" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "count" BIGINT NOT NULL DEFAULT 0 CHECK ("count" >= 0),
  PRIMARY KEY ("scope", "subject_digest", "window_start"),
  CONSTRAINT "rate_limit_buckets_expiry_check" CHECK ("expires_at" > "window_start")
);
CREATE INDEX "rate_limit_buckets_expiry_idx" ON "rate_limit_buckets" ("expires_at");
