-- Stage 2.2 (approved R1 + deny-by-default RLS posture): role-scoped RLS
-- policies for the sanctioned server-side access path.
--
-- WHY THIS EXISTS (documented deviation from the Stage 2.1 "zero policies"
-- freeze): with DATABASE_URL moved to stratifit_runtime (R1), the application
-- is a NON-OWNER role. RLS-enabled tables with zero policies filter every row
-- for non-owner roles, so the runtime path could not read or write its own
-- tables. The approved R1 constraints forbid both runtime table ownership and
-- BYPASSRLS, so the minimal compliant mechanism is explicit per-role policies:
--   - stratifit_runtime: full row access (the sanctioned service path);
--   - anon / authenticated / service_role / PUBLIC: remain DENIED (no policy).
-- RLS stays ENABLED on every table; deny-by-default is preserved for the
-- Supabase Data API surface.
--
-- Rollback (reverse-SQL):
--   DROP POLICY IF EXISTS runtime_all ON public.<table>;  -- for each table below

--> statement-breakpoint
CREATE POLICY runtime_all ON public.organizations FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_all ON public.operators FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_all ON public.audience_users FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_all ON public.verification_requirements FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_all ON public.teams FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY runtime_all ON public.org_memberships FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
