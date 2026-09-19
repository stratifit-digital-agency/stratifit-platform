-- Stage 2.12 (approved Publishing Foundation plan): explicit runtime-role
-- privileges and RLS policies for the Publishing family (SVC section 11
-- context 11).
--
-- PRIVILEGE MODEL (the migration-0009/0011/0013/0016/0018/0020/0022
-- append-only pattern):
--   - publications (mutable publication aggregate root — DM section 19 /
--     section 29-19; D2.12-C: full DM section 32.6 lifecycle draft →
--     pending_approval → approved → scheduled → publishing → published →
--     unpublished, publishing → failed, failed → pending_approval):
--       SELECT + INSERT + UPDATE + DELETE for stratifit_runtime;
--   - publication_versions (IMMUTABLE snapshot family — DM section 33: "a
--     correction is a NEW version, never an overwrite"; D2.12-B: the payload
--     snapshots all publishable fields so it never depends on mutable source
--     records; D2.12-E: created at create (v1) and at draft-only revise):
--       INSERT + SELECT ONLY. UPDATE and DELETE are NEVER granted and no
--       UPDATE/DELETE RLS policy exists, so a compromised runtime role still
--       cannot rewrite or remove publication history;
--   - distribution_references (IMMUTABLE attempt record — per-delivery
--     identity without provider credentials; D2.12-F: operator-initiated
--     synchronous delivery only, no worker data):
--       INSERT + SELECT ONLY, same posture.
--
-- RLS stays ENABLED on all three tables; policies are role-scoped to
-- stratifit_runtime only (the sanctioned server path). anon / authenticated /
-- service_role / PUBLIC remain denied (no policy for them). No blanket or
-- default privileges are introduced (Stage 2.2 Option A posture preserved).
-- No SECURITY DEFINER function is required: Publishing introduces no
-- execution and no cross-family mutation (publication failure NEVER
-- invalidates the underlying master asset/production — DM invariant 5; there
-- is no SQL path from this family into assets/generations/productions at
-- all).
--
-- Organization ownership of loose subject_ref values (production,
-- asset_version) is enforced by the service layer through narrow read-only
-- upstream lookup ports (approved D2.12-D); ai_creator_profile /
-- campaign_creative subjects fail closed until their bounded contexts exist.
-- The ratified Stage 2.7 model is unchanged: cross-org mutation is prevented
-- on the trusted application path by service-level organization
-- authorization; database RLS enforces role-gated row access and is not an
-- independent principal→organization authorization boundary.
--
-- Runtime allowlist after this migration: exactly 34 tables.
--
-- Rollback (reverse-SQL):
--   DROP POLICY IF EXISTS runtime_all ON public.publications;
--   DROP POLICY IF EXISTS runtime_insert ON public.publication_versions;
--   DROP POLICY IF EXISTS runtime_select ON public.publication_versions;
--   DROP POLICY IF EXISTS runtime_insert ON public.distribution_references;
--   DROP POLICY IF EXISTS runtime_select ON public.distribution_references;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.publications FROM stratifit_runtime;
--   REVOKE SELECT, INSERT ON TABLE public.publication_versions FROM stratifit_runtime;
--   REVOKE SELECT, INSERT ON TABLE public.distribution_references FROM stratifit_runtime;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.publications TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.publication_versions TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.distribution_references TO stratifit_runtime;
--> statement-breakpoint
CREATE POLICY runtime_all ON public.publications FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_insert ON public.publication_versions FOR INSERT TO stratifit_runtime WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_select ON public.publication_versions FOR SELECT TO stratifit_runtime USING (true);
--> statement-breakpoint
CREATE POLICY runtime_insert ON public.distribution_references FOR INSERT TO stratifit_runtime WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_select ON public.distribution_references FOR SELECT TO stratifit_runtime USING (true);
