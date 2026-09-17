-- Stage 2.2 least-privilege reduction (follow-up discovery by the new
-- privilege guard): the R1 runtime-role grants on the Stage 2.1 identity
-- tables were applied ad hoc during the two-role implementation (management
-- channel + owner-issued statements) and were never recorded in the canonical
-- Drizzle migration stream. With the blanket stratifit_app default privilege
-- removed by 0006, the migration history must be self-sufficient: this
-- migration records the explicit, already-live grants so an environment built
-- purely from Drizzle migrations yields the identical privilege state.
--
-- No privilege is added or removed relative to the approved live state —
-- GRANT is idempotent. platform_config deliberately receives NO grant here
-- (approved: zero runtime access; managed via the migration path only).
--
-- Rollback (reverse-SQL):
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.organizations FROM stratifit_runtime;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.operators FROM stratifit_runtime;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.audience_users FROM stratifit_runtime;
--   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.verification_requirements FROM stratifit_runtime;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.organizations TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.operators TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.audience_users TO stratifit_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.verification_requirements TO stratifit_runtime;
