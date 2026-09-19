-- 0032 — Social Graph grants + RLS (Stage 2.15, exact 0024/0028/0030 pattern).
-- The runtime role is the ONLY grantee; no PUBLIC privileges; no new
-- principals. All five social aggregates are runtime ARWD — owner-scoped
-- mutations are enforced at the social service layer (userId/org server-
-- derived; D2.15-3: no social.* events; D2.15-4: visibility filtering is a
-- service-layer rule). RLS is role-scoped per the ratified Stage 2.7 tenancy
-- model; owner/org conditioning remains application-level (RLS is not
-- principal->org binding — Phase 3 debt).

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.likes TO stratifit_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.saves TO stratifit_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.follow_graph TO stratifit_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.comments TO stratifit_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.shares TO stratifit_runtime;

CREATE POLICY runtime_all ON public.likes FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
CREATE POLICY runtime_all ON public.saves FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
CREATE POLICY runtime_all ON public.follow_graph FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
CREATE POLICY runtime_all ON public.comments FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);
CREATE POLICY runtime_all ON public.shares FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);

--> statement-breakpoint
-- ROLLBACK:
-- DROP POLICY IF EXISTS runtime_all ON public.likes;
-- DROP POLICY IF EXISTS runtime_all ON public.saves;
-- DROP POLICY IF EXISTS runtime_all ON public.follow_graph;
-- DROP POLICY IF EXISTS runtime_all ON public.comments;
-- DROP POLICY IF EXISTS runtime_all ON public.shares;
-- REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.likes FROM stratifit_runtime;
-- REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.saves FROM stratifit_runtime;
-- REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.follow_graph FROM stratifit_runtime;
-- REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.comments FROM stratifit_runtime;
-- REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.shares FROM stratifit_runtime;
