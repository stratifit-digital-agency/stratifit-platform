-- 0028 — public_content grants + RLS (Stage 2.13, exact 0024 pattern).
-- The runtime role is the ONLY grantee; no PUBLIC privileges; no new
-- principals. public_content is a MUTABLE family (runtime ARWD) — the status
-- flip is its only sanctioned mutation. RLS is org-scoped at the policy
-- layer; org authority remains application-level (actor.organizationId) per
-- the ratified Stage 2.7 tenancy model (RLS is not principal->org binding).

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.public_content TO stratifit_runtime;

CREATE POLICY runtime_all ON public.public_content FOR ALL TO stratifit_runtime USING (true) WITH CHECK (true);

--> statement-breakpoint
-- ROLLBACK:
-- DROP POLICY IF EXISTS runtime_all ON public.public_content;
-- REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.public_content FROM stratifit_runtime;
