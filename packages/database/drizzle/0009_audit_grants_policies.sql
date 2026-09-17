-- Stage 2.4 (approved D2.4-1..3): explicit runtime-role privileges and RLS
-- policies for audit_log (Decision 4 — the sanctioned append-only audit path).
--
-- APPEND-ONLY BY CONSTRUCTION: stratifit_runtime receives INSERT + SELECT
-- only. UPDATE and DELETE are NEVER granted and no UPDATE/DELETE RLS policy
-- exists, so a compromised runtime role still cannot mutate history. Rows are
-- also immutable at the schema level (no updated_at column). Reads are
-- additionally org-scoped at the service layer (D2.4-2); anon / authenticated
-- / service_role / PUBLIC remain denied (no policy for them).
--
-- Rollback (reverse-SQL):
--   DROP POLICY IF EXISTS audit_insert ON public.audit_log;
--   DROP POLICY IF EXISTS audit_select ON public.audit_log;
--   REVOKE INSERT, SELECT ON TABLE public.audit_log FROM stratifit_runtime;

--> statement-breakpoint
GRANT INSERT, SELECT ON TABLE public.audit_log TO stratifit_runtime;
--> statement-breakpoint
CREATE POLICY audit_insert ON public.audit_log FOR INSERT TO stratifit_runtime WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY audit_select ON public.audit_log FOR SELECT TO stratifit_runtime USING (true);
