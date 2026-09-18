-- Stage 2.7 (approved decisions D2.7-1..D2.7-5): explicit runtime-role
-- privileges and RLS policies for the Job/Compute domain family.
--
-- PRIVILEGE MODEL (D2.7-4/D2.7-5, the migration-0009/0011 append-only pattern):
--   - jobs, job_dependencies, compute_requirements, compute_usage
--     (mutable families — DM section 16 aggregates/records):
--       SELECT + INSERT + UPDATE + DELETE for stratifit_runtime;
--   - job_attempts (immutable attempt history — DM section 16 "attempts are
--     recorded immutably"):
--       INSERT + SELECT ONLY. UPDATE and DELETE are NEVER granted and no
--       UPDATE/DELETE RLS policy exists, so a compromised runtime role still
--       cannot rewrite or remove execution history.
--
-- RLS stays ENABLED on all five tables; policies are role-scoped to
-- stratifit_runtime only (the sanctioned server path). anon / authenticated /
-- service_role / PUBLIC remain denied (no policy for them). No blanket or
-- default privileges are introduced (Stage 2.2 Option A posture preserved).
-- D2.7-5: these tables ARE the durable job state — no outbox tables exist.
-- D2.7-4: no worker/lease/heartbeat tables exist.
--
-- Rollback (reverse-SQL):
--   DROP POLICY IF EXISTS runtime_all ON public.jobs;
--   DROP POLICY IF EXISTS runtime_all ON public.job_dependencies;
--   DROP POLICY IF EXISTS runtime_insert ON public.job_attempts;
--   DROP POLICY IF EXISTS runtime_select ON public.job_attempts;
--   DROP POLICY IF EXISTS runtime_all ON public.compute_requirements;
--   DROP POLICY IF EXISTS runtime_all ON public.compute_usage;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.jobs FROM stratifit_runtime;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.job_dependencies FROM stratifit_runtime;
--   REVOKE SELECT, INSERT ON TABLE public.job_attempts FROM stratifit_runtime;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.compute_requirements FROM stratifit_runtime;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.compute_usage FROM stratifit_runtime;
--   DROP TRIGGER enforce_job_dependency_same_org ON public.job_dependencies;
--   DROP FUNCTION public.enforce_job_dependency_same_org();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.enforce_job_dependency_same_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id IN (NEW.job_id, NEW.depends_on_job_id)
    GROUP BY j.org_id HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'job dependency endpoints must belong to a single organization';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.jobs TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.job_dependencies TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.job_attempts TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.compute_requirements TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.compute_usage TO stratifit_runtime;
--> statement-breakpoint
CREATE POLICY runtime_all ON public.jobs FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_all ON public.job_dependencies FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_insert ON public.job_attempts FOR INSERT TO stratifit_runtime WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_select ON public.job_attempts FOR SELECT TO stratifit_runtime USING (true);
--> statement-breakpoint
CREATE POLICY runtime_all ON public.compute_requirements FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_all ON public.compute_usage FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE TRIGGER enforce_job_dependency_same_org
  BEFORE INSERT ON public.job_dependencies
  FOR EACH ROW EXECUTE FUNCTION public.enforce_job_dependency_same_org();
