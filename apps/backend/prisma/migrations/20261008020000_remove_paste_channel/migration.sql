-- Keep previously applied migrations immutable and retain all existing audit rows.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "audit_events" WHERE "channel" = 'PASTE') THEN
    RAISE EXCEPTION 'Cannot remove PASTE channel while historical audit rows use it; resolve audit retention before retrying.';
  END IF;
END $$;

CREATE TYPE "IngestionChannel_without_paste" AS ENUM ('FILE_JSON', 'FILE_ZIP', 'INTEGRATION_API');
ALTER TABLE "audit_events" ALTER COLUMN "channel" TYPE "IngestionChannel_without_paste"
  USING ("channel"::text::"IngestionChannel_without_paste");
DROP TYPE "IngestionChannel";
ALTER TYPE "IngestionChannel_without_paste" RENAME TO "IngestionChannel";

COMMIT;
