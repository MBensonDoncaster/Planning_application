-- Apply using psql as the database operator after migrating:
-- psql -v app_schema=public -v runtime_role=planning_runtime -f runtime-grants.sql
-- runtime_role must be a separate non-owner with no privileged memberships.
BEGIN;
REVOKE CREATE ON SCHEMA :"app_schema" FROM PUBLIC, :"runtime_role";
GRANT USAGE ON SCHEMA :"app_schema" TO :"runtime_role";
REVOKE ALL ON TABLE :"app_schema"."users", :"app_schema"."integrations", :"app_schema"."api_keys",
  :"app_schema"."audit_events", :"app_schema"."idempotency_records", :"app_schema"."rate_limit_buckets",
  :"app_schema"."_prisma_migrations" FROM :"runtime_role";
REVOKE ALL ON TABLE :"app_schema"."audit_events" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE :"app_schema"."users", :"app_schema"."integrations", :"app_schema"."api_keys" TO :"runtime_role";
GRANT SELECT, INSERT ON TABLE :"app_schema"."audit_events" TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE :"app_schema"."idempotency_records", :"app_schema"."rate_limit_buckets" TO :"runtime_role";
COMMIT;
