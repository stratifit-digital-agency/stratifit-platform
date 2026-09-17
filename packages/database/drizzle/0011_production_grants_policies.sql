-- Stage 2.6 (approved decisions D2.6-1..D2.6-4): explicit runtime-role
-- privileges and RLS policies for the Production domain family.
--
-- PRIVILEGE MODEL (D2.6-4, the migration-0009 append-only pattern):
--   - projects, productions (mutable aggregates):
--       SELECT + INSERT + UPDATE + DELETE for stratifit_runtime;
--   - production_plan_versions, gate_decision_records, manifest_versions
--     (immutable version families — DM section 33 "immutable version rows"):
--       INSERT + SELECT ONLY. UPDATE and DELETE are NEVER granted and no
--       UPDATE/DELETE RLS policy exists, so a compromised runtime role still
--       cannot rewrite or remove domain history.
--
-- RLS stays ENABLED on all five tables; policies are role-scoped to
-- stratifit_runtime only (the sanctioned server path). anon / authenticated /
-- service_role / PUBLIC remain denied (no policy for them). No blanket or
-- default privileges are introduced (Stage 2.2 Option A posture preserved).
--
-- Rollback (reverse-SQL):
--   DROP POLICY IF EXISTS runtime_all ON public.projects;
--   DROP POLICY IF EXISTS runtime_all ON public.productions;
--   DROP POLICY IF EXISTS runtime_all ON public.production_plan_versions;
--   DROP POLICY IF EXISTS runtime_all ON public.gate_decision_records;
--   DROP POLICY IF EXISTS runtime_all ON public.manifest_versions;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.projects FROM stratifit_runtime;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.productions FROM stratifit_runtime;
--   REVOKE SELECT, INSERT ON TABLE public.production_plan_versions FROM stratifit_runtime;
--   REVOKE SELECT, INSERT ON TABLE public.gate_decision_records FROM stratifit_runtime;
--   REVOKE SELECT, INSERT ON TABLE public.manifest_versions FROM stratifit_runtime;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.projects TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.productions TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.production_plan_versions TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.gate_decision_records TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.manifest_versions TO stratifit_runtime;
--> statement-breakpoint
CREATE POLICY runtime_all ON public.projects FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_all ON public.productions FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_insert ON public.production_plan_versions FOR INSERT TO stratifit_runtime WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_select ON public.production_plan_versions FOR SELECT TO stratifit_runtime USING (true);
--> statement-breakpoint
CREATE POLICY runtime_insert ON public.gate_decision_records FOR INSERT TO stratifit_runtime WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_select ON public.gate_decision_records FOR SELECT TO stratifit_runtime USING (true);
--> statement-breakpoint
CREATE POLICY runtime_insert ON public.manifest_versions FOR INSERT TO stratifit_runtime WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_select ON public.manifest_versions FOR SELECT TO stratifit_runtime USING (true);
