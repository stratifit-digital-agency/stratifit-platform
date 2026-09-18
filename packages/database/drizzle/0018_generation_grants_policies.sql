-- Stage 2.9 (approved Generation Foundation plan): explicit runtime-role
-- privileges and RLS policies for the Generation domain family.
--
-- PRIVILEGE MODEL (the migration-0009/0011/0013/0016 append-only pattern):
--   - generations (mutable lifecycle aggregate — DM section 13/32.3):
--       SELECT + INSERT + UPDATE + DELETE for stratifit_runtime;
--   - generation_provenance (immutable completion record — DM section 13
--     "historical provenance is immutable" / invariant 3 / section 34
--     "written once"):
--       INSERT + SELECT ONLY. UPDATE and DELETE are NEVER granted and no
--       UPDATE/DELETE RLS policy exists, so a compromised runtime role still
--       cannot rewrite or remove completion provenance.
--
-- RLS stays ENABLED on both tables; policies are role-scoped to
-- stratifit_runtime only (the sanctioned server path). anon / authenticated /
-- service_role / PUBLIC remain denied (no policy for them). No blanket or
-- default privileges are introduced (Stage 2.2 Option A posture preserved).
--
-- Runtime allowlist after this migration: exactly 22 tables.
--
-- Rollback (reverse-SQL):
--   DROP POLICY IF EXISTS runtime_all ON public.generations;
--   DROP POLICY IF EXISTS runtime_insert ON public.generation_provenance;
--   DROP POLICY IF EXISTS runtime_select ON public.generation_provenance;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.generations FROM stratifit_runtime;
--   REVOKE SELECT, INSERT ON TABLE public.generation_provenance FROM stratifit_runtime;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.generations TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.generation_provenance TO stratifit_runtime;
--> statement-breakpoint
CREATE POLICY runtime_all ON public.generations FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_insert ON public.generation_provenance FOR INSERT TO stratifit_runtime WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_select ON public.generation_provenance FOR SELECT TO stratifit_runtime USING (true);
