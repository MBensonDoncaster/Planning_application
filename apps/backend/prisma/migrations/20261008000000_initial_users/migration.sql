CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

CREATE TYPE "UserStatus" AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED',
    'DISABLED'
);

CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "sso_subject" VARCHAR(255) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "display_name" VARCHAR(200) NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "last_login_at" TIMESTAMPTZ(3),
    "approved_at" TIMESTAMPTZ(3),
    "approved_by_user_id" UUID,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "users_approved_by_user_id_fkey"
        FOREIGN KEY ("approved_by_user_id")
        REFERENCES "users" ("id")
        ON DELETE SET NULL
        ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "users_sso_subject_key"
    ON "users" ("sso_subject");

CREATE INDEX "users_status_idx"
    ON "users" ("status");

CREATE INDEX "users_role_idx"
    ON "users" ("role");