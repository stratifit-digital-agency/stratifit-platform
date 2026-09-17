-- Stage 2.2 (approved decision R1): explicit runtime-role privileges for the
-- tables created by 0003. The stratifit_app default-privileges rule also
-- auto-grants these; the explicit GRANT here is the auditable, canonical
-- statement so future migrations follow this exact pattern (CRITICAL rule:
-- the runtime role must never own application tables).
--
-- Rollback (reverse-SQL):
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON public.teams FROM stratifit_runtime;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON public.org_memberships FROM stratifit_runtime;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.teams TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.org_memberships TO stratifit_runtime;
