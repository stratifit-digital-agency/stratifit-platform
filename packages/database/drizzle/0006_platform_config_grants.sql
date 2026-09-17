-- Stage 2.2 (approved least-privilege reduction): runtime privileges on
-- platform_config are REMOVED. platform_config is a platform-level table with
-- ZERO runtime consumers today (verified by code search across
-- services/identity, Control, Media, packages/database and tests at approval
-- time); its management belongs to the migration/platform-operations path
-- (DATABASE_MIGRATE_URL / stratifit_app), never the runtime role.
--
-- ALSO (approved Option A): the blanket stratifit_app default table privilege
-- that auto-granted arwd on every future stratifit_app table to
-- stratifit_runtime is removed. Future runtime privileges must be explicit,
-- per-table, and justified by an actual runtime consumer in an auditable
-- migration following the drizzle/0004_membership_grants.sql pattern.
--
-- Rollback (reverse-SQL):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_config TO stratifit_runtime;
--   ALTER DEFAULT PRIVILEGES FOR ROLE stratifit_app IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stratifit_runtime;

--> statement-breakpoint
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_config FROM stratifit_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE stratifit_app IN SCHEMA public REVOKE ALL ON TABLES FROM stratifit_runtime;
