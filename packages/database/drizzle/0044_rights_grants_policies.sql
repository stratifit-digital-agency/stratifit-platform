-- =============================================================================
-- 0044 - Rights & Consent grants + RLS (Stage 2.21, D2.21-1..D2.21-8)
--
-- Pattern parity with 0038/0040/0042: runtime grants are role-scoped
-- (stratifit_runtime) with exactly one runtime_all policy per table. Zero
-- PUBLIC grants. Zero other grantees.
--
-- Tables (3, D2.21-7): rights_owners + rights_grants = mutable ARWD family;
-- rights_status_events = IMMUTABLE history-of-record (INSERT + SELECT only,
-- live 42501 proofs required). Grant map 61 -> 64.
--
-- Grant core-field immutability (D2.21-6) is service-enforced (no update
-- path exists); subject/owner same-org integrity is service-enforced inside
-- the transaction. No Media surface; ports unwired (D2.21-2); no rights.*
-- events (D2.21-3).
--
-- Rollback:
--   REVOKE ALL ON rights_owners, rights_grants, rights_status_events
--     FROM stratifit_runtime;
--   DROP POLICY runtime_all ON <each table>;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- rights_owners (mutable)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rights_owners TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.rights_owners
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- rights_grants (mutable aggregate; core immutability service-enforced)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rights_grants TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.rights_grants
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- rights_status_events (IMMUTABLE history-of-record family)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT ON TABLE public.rights_status_events TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.rights_status_events
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);
