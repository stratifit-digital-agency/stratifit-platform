-- Stage 2.8 (approved Catalog Foundation plan): explicit runtime-role
-- privileges and RLS policies for the Catalog (Model/Workflow) domain family.
--
-- PRIVILEGE MODEL (the migration-0009/0011/0013 append-only pattern):
--   - models, workflows (mutable registry parents — DM section 14/15):
--       SELECT + INSERT + UPDATE + DELETE for stratifit_runtime;
--   - model_versions, workflow_versions (immutable version families —
--     DM section 33 "immutable version rows", section 15 "historical workflow
--     versions are never deleted or rewritten"):
--       INSERT + SELECT ONLY. UPDATE and DELETE are NEVER granted and no
--       UPDATE/DELETE RLS policy exists, so a compromised runtime role still
--       cannot rewrite or remove version history.
--
-- RLS stays ENABLED on all four tables; policies are role-scoped to
-- stratifit_runtime only (the sanctioned server path). anon / authenticated /
-- service_role / PUBLIC remain denied (no policy for them). No blanket or
-- default privileges are introduced (Stage 2.2 Option A posture preserved).
--
-- Runtime allowlist after this migration: exactly 21 tables.
--
-- Rollback (reverse-SQL):
--   DROP POLICY IF EXISTS runtime_all ON public.models;
--   DROP POLICY IF EXISTS runtime_all ON public.model_versions;
--   DROP POLICY IF EXISTS runtime_insert ON public.model_versions;
--   DROP POLICY IF EXISTS runtime_select ON public.model_versions;
--   DROP POLICY IF EXISTS runtime_all ON public.workflows;
--   DROP POLICY IF EXISTS runtime_all ON public.workflow_versions;
--   DROP POLICY IF EXISTS runtime_insert ON public.workflow_versions;
--   DROP POLICY IF EXISTS runtime_select ON public.workflow_versions;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.models FROM stratifit_runtime;
--   REVOKE SELECT, INSERT ON TABLE public.model_versions FROM stratifit_runtime;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.workflows FROM stratifit_runtime;
--   REVOKE SELECT, INSERT ON TABLE public.workflow_versions FROM stratifit_runtime;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.models TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.model_versions TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workflows TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.workflow_versions TO stratifit_runtime;
--> statement-breakpoint
CREATE POLICY runtime_all ON public.models FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_insert ON public.model_versions FOR INSERT TO stratifit_runtime WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_select ON public.model_versions FOR SELECT TO stratifit_runtime USING (true);
--> statement-breakpoint
CREATE POLICY runtime_all ON public.workflows FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_insert ON public.workflow_versions FOR INSERT TO stratifit_runtime WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_select ON public.workflow_versions FOR SELECT TO stratifit_runtime USING (true);
