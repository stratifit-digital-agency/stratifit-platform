-- Stage 2.11 (approved QC Foundation plan): explicit runtime-role privileges
-- and RLS policies for the Quality Control family (SVC section 11 context 10).
--
-- PRIVILEGE MODEL (the migration-0009/0011/0013/0016/0018/0020 append-only
-- pattern):
--   - qc_checks (mutable definition aggregate — DM section 18 "QC Check
--     (definition)"; D2.11-7 status is exactly active|archived):
--       SELECT + INSERT + UPDATE + DELETE for stratifit_runtime;
--   - qc_reviews (mutable per-subject lifecycle aggregate — DM section 18 /
--     section 32.5 "pending → in_review → approved | rejected |
--     changes_requested"):
--       SELECT + INSERT + UPDATE + DELETE for stratifit_runtime;
--   - qc_review_decisions (IMMUTABLE evidence — DM section 18: "the decision
--     record is immutable"; invariant 3: corrections are superseding records,
--     never edits; D2.11-3):
--       INSERT + SELECT ONLY. UPDATE and DELETE are NEVER granted and no
--       UPDATE/DELETE RLS policy exists, so a compromised runtime role still
--       cannot rewrite or remove review decisions;
--   - qc_results (IMMUTABLE append-only results — DM section 18 "QC Result
--     (immutable)"; multiple results per (review, check) are history and are
--     never overwritten):
--       INSERT + SELECT ONLY, same posture;
--   - qc_issues (mutable resolution lifecycle — DM section 18 "QC Issue":
--     severity + resolution open → resolved | waived):
--       SELECT + INSERT + UPDATE + DELETE for stratifit_runtime.
--
-- RLS stays ENABLED on all five tables; policies are role-scoped to
-- stratifit_runtime only (the sanctioned server path). anon / authenticated /
-- service_role / PUBLIC remain denied (no policy for them). No blanket or
-- default privileges are introduced (Stage 2.2 Option A posture preserved).
-- No SECURITY DEFINER function is required: QC introduces no execution and
-- no cross-family mutation (the hard Stage 2.11 domain-separation rule: QC
-- never mutates asset approval state — there is no SQL path from this family
-- into assets at all).
--
-- Organization ownership of loose subject_ref values (asset_version,
-- generation, production) is enforced by the service layer through narrow
-- read-only upstream lookup ports (approved D2.11-2); publication subjects
-- fail closed until durable Publishing exists. The ratified Stage 2.7 model
-- is unchanged: cross-org mutation is prevented on the trusted application
-- path by service-level organization authorization; database RLS enforces
-- role-gated row access and is not an independent principal→organization
-- authorization boundary.
--
-- Runtime allowlist after this migration: exactly 31 tables.
--
-- Rollback (reverse-SQL):
--   DROP POLICY IF EXISTS runtime_all ON public.qc_checks;
--   DROP POLICY IF EXISTS runtime_all ON public.qc_reviews;
--   DROP POLICY IF EXISTS runtime_insert ON public.qc_review_decisions;
--   DROP POLICY IF EXISTS runtime_select ON public.qc_review_decisions;
--   DROP POLICY IF EXISTS runtime_insert ON public.qc_results;
--   DROP POLICY IF EXISTS runtime_select ON public.qc_results;
--   DROP POLICY IF EXISTS runtime_all ON public.qc_issues;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.qc_checks FROM stratifit_runtime;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.qc_reviews FROM stratifit_runtime;
--   REVOKE SELECT, INSERT ON TABLE public.qc_review_decisions FROM stratifit_runtime;
--   REVOKE SELECT, INSERT ON TABLE public.qc_results FROM stratifit_runtime;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.qc_issues FROM stratifit_runtime;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.qc_checks TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.qc_reviews TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.qc_review_decisions TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.qc_results TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.qc_issues TO stratifit_runtime;
--> statement-breakpoint
CREATE POLICY runtime_all ON public.qc_checks FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_all ON public.qc_reviews FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_insert ON public.qc_review_decisions FOR INSERT TO stratifit_runtime WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_select ON public.qc_review_decisions FOR SELECT TO stratifit_runtime USING (true);
--> statement-breakpoint
CREATE POLICY runtime_insert ON public.qc_results FOR INSERT TO stratifit_runtime WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_select ON public.qc_results FOR SELECT TO stratifit_runtime USING (true);
--> statement-breakpoint
CREATE POLICY runtime_all ON public.qc_issues FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
