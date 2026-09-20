-- =============================================================================
-- 0036 — Messaging & Leads Foundation grants + RLS (Stage 2.17, D2.17-1..D2.17-11)
--
-- Pattern parity with 0024/0028/0030/0032/0034: runtime grants are role-scoped
-- (stratifit_runtime) with one runtime_all policy per table. Zero PUBLIC
-- grants. Zero other grantees.
--
-- Tables: conversations, service_inquiries, service_leads, service_offerings
-- (mutable aggregates — ARWD) + messages, lead_follow_ups (IMMUTABLE families
-- per DM section 32.8/24 — INSERT+SELECT only; live 42501 proofs required).
--
-- NAMING NOTE (authorized Stage 2.17 deviation): the shared Supabase project
-- hosts a pre-existing FOREIGN marketing/CRM application schema. public.leads
-- and public.services are actively used by that application, are owned by the
-- postgres role, and are NOT administerable by the platform roles. Stage 2.17
-- therefore names its offering/lead tables service_offerings and service_leads
-- to avoid cross-application collisions. The foreign tables remain completely
-- outside the platform grant/RLS surface.
--
-- Rollback:
--   REVOKE ALL ON conversations, messages, service_offerings, service_inquiries,
--     service_leads, lead_follow_ups FROM stratifit_runtime;
--   DROP POLICY runtime_all ON conversations; ... (x6)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- conversations (mutable aggregate)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.conversations TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.conversations
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- messages (IMMUTABLE family)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT ON TABLE public.messages TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.messages
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- service_offerings (mutable)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.service_offerings TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.service_offerings
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- service_inquiries (mutable)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.service_inquiries TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.service_inquiries
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- service_leads (mutable)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.service_leads TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.service_leads
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- lead_follow_ups (IMMUTABLE family)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT ON TABLE public.lead_follow_ups TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.lead_follow_ups
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);
