-- =============================================================================
-- 0040 - Analytics Intake grants + RLS (Stage 2.19, D2.19-A1..A6)
--
-- Pattern parity with 0024/0028/0030/0032/0034/0036/0038: runtime grants are
-- role-scoped (stratifit_runtime) with one runtime_all policy. Zero PUBLIC
-- grants. Zero other grantees.
--
-- Table: analytics_events (IMMUTABLE family - INSERT + SELECT only; the
-- platform's first public unauthenticated write surface, D2.19-A1). UPDATE
-- and DELETE must never exist; live 42501 proofs are required by the Stage
-- 2.19 freeze. Replay idempotency via UNIQUE(ingest_event_id).
--
-- Rollback:
--   REVOKE ALL ON analytics_events FROM stratifit_runtime;
--   DROP POLICY runtime_all ON analytics_events;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- analytics_events (immutable intake family)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT ON TABLE public.analytics_events TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.analytics_events
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);
