-- =============================================================================
-- 0038 - In-app Notifications grants + RLS (Stage 2.18, D2.18-SELECT/N1..N5)
--
-- Pattern parity with 0024/0028/0030/0032/0034/0036: runtime grants are
-- role-scoped (stratifit_runtime) with one runtime_all policy. Zero PUBLIC
-- grants. Zero other grantees.
--
-- Table: notifications (MUTABLE owner aggregate - ARWD). Audience-private
-- feed; owner scoping is SERVICE-enforced on the server-derived
-- audienceUserId (watch_progress Stage 2.14 precedent - no per-owner RLS
-- predicates per the Stage 2.18 freeze). Unread state is derived
-- (read_at IS NULL, D2.18-N5); event_id UNIQUE is the consumer idempotency
-- key (D2.18-P1).
--
-- Rollback:
--   REVOKE ALL ON notifications FROM stratifit_runtime;
--   DROP POLICY runtime_all ON notifications;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- notifications (mutable owner aggregate)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notifications TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.notifications
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);
