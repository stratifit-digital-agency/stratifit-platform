-- Stage 2.10 (approved Asset Domain Foundation plan): explicit runtime-role
-- privileges and RLS policies for the Asset domain family.
--
-- PRIVILEGE MODEL (the migration-0009/0011/0013/0016/0018 append-only
-- pattern):
--   - assets (mutable lifecycle aggregate — DM section 12/32.4; D2.10-1: the
--     approval state machine lives on THIS aggregate):
--       SELECT + INSERT + UPDATE + DELETE for stratifit_runtime;
--   - asset_versions (immutable version family — DM section 12 "Asset
--     Version (immutable)" / invariant 24 "versioned entities mutate only
--     by appending new versions"):
--       INSERT + SELECT ONLY. UPDATE and DELETE are NEVER granted and no
--       UPDATE/DELETE RLS policy exists, so a compromised runtime role still
--       cannot rewrite or remove version history;
--   - asset_lineage (immutable DAG edges — DM section 12 / invariant 25
--     "cycles and parent rewrites are rejected"):
--       INSERT + SELECT ONLY, same posture.
--
-- RLS stays ENABLED on all three tables; policies are role-scoped to
-- stratifit_runtime only (the sanctioned server path). anon / authenticated /
-- service_role / PUBLIC remain denied (no policy for them). No blanket or
-- default privileges are introduced (Stage 2.2 Option A posture preserved).
-- No SECURITY DEFINER function is required: the runtime role needs no
-- mutation capability on the immutable families beyond INSERT/SELECT, and
-- org consistency for lineage edges is enforced by the service layer plus
-- the intra-family FKs (same table family, same org column pattern).
--
-- Runtime allowlist after this migration: exactly 26 tables.
--
-- Rollback (reverse-SQL):
--   DROP POLICY IF EXISTS runtime_all ON public.assets;
--   DROP POLICY IF EXISTS runtime_insert ON public.asset_versions;
--   DROP POLICY IF EXISTS runtime_select ON public.asset_versions;
--   DROP POLICY IF EXISTS runtime_insert ON public.asset_lineage;
--   DROP POLICY IF EXISTS runtime_select ON public.asset_lineage;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.assets FROM stratifit_runtime;
--   REVOKE SELECT, INSERT ON TABLE public.asset_versions FROM stratifit_runtime;
--   REVOKE SELECT, INSERT ON TABLE public.asset_lineage FROM stratifit_runtime;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.assets TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.asset_versions TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.asset_lineage TO stratifit_runtime;
--> statement-breakpoint
CREATE POLICY runtime_all ON public.assets FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_insert ON public.asset_versions FOR INSERT TO stratifit_runtime WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_select ON public.asset_versions FOR SELECT TO stratifit_runtime USING (true);
--> statement-breakpoint
CREATE POLICY runtime_insert ON public.asset_lineage FOR INSERT TO stratifit_runtime WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_select ON public.asset_lineage FOR SELECT TO stratifit_runtime USING (true);
