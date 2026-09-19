-- 0030 — watch_progress grants + RLS (Stage 2.14, exact 0024/0028 pattern).
-- The runtime role is the ONLY grantee; no PUBLIC privileges; no new
-- principals. watch_progress is MUTABLE audience owner state (runtime ARWD)
-- mutated only through the audience module's owner-scoped command API
-- (userId server-derived, D2.14-2: no audit writes). RLS is role-scoped per
-- the ratified Stage 2.7 tenancy model; owner/org conditioning remains
-- application-level (RLS is not principal->org binding — Phase 3 debt).

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.watch_progress TO stratifit_runtime;

CREATE POLICY runtime_all ON public.watch_progress FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);

--> statement-breakpoint
-- ROLLBACK:
-- DROP POLICY IF EXISTS runtime_all ON public.watch_progress;
-- REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.watch_progress FROM stratifit_runtime;
