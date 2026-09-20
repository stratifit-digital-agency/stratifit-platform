-- =============================================================================
-- 0034 — People Foundation grants + RLS (Stage 2.16, D2.16-1..D2.16-8)
--
-- Pattern parity with 0024/0028/0030/0032: runtime grants are role-scoped
-- (stratifit_runtime) with one runtime_all policy per table. Zero PUBLIC
-- grants. Zero other grantees.
--
-- Tables: digital_humans, characters, personas, ai_creators (Control-authored
-- mutable chain aggregates) + creator_profiles (publication-authored snapshot
-- family — runtime ARWD because the mediation seam writes via the runtime
-- role; immutability of history is enforced by the service + partial uniques,
-- not by denying UPDATE).
--
-- Rollback:
--   REVOKE ALL ON digital_humans, characters, personas, ai_creators,
--     creator_profiles FROM stratifit_runtime;
--   DROP POLICY runtime_all ON digital_humans; ... (x5)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- digital_humans
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.digital_humans TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.digital_humans
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- characters
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.characters TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.characters
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- personas
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.personas TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.personas
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- ai_creators
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_creators TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.ai_creators
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- creator_profiles (publication-authored snapshot family)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.creator_profiles TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.creator_profiles
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);
