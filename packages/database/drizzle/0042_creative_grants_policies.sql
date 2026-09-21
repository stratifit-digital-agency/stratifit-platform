-- =============================================================================
-- 0042 - Creative / Story grants + RLS (Stage 2.20, D2.20-1..D2.20-9)
--
-- Pattern parity with 0024/0028/0030/0032/0034/0036/0038/0040: runtime grants
-- are role-scoped (stratifit_runtime) with exactly one runtime_all policy per
-- table. Zero PUBLIC grants. Zero other grantees.
--
-- Tables (7, mutable ARWD family — D2.20-9): universes, worlds, stories,
-- seasons, episodes, scenes, shots. Grant map 54 -> 61.
--
-- All are org-scoped aggregates with server-side parent-chain integrity
-- (same-org, non-retired parents enforced at the service layer); FK RESTRICT
-- protects every hierarchy edge. No Media surface (D2.20-7); no creative.*
-- events (D2.20-4).
--
-- Rollback:
--   REVOKE ALL ON universes, worlds, stories, seasons, episodes, scenes, shots
--     FROM stratifit_runtime;
--   DROP POLICY runtime_all ON <each table>;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- universes
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.universes TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.universes
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- worlds
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.worlds TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.worlds
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- stories
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stories TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.stories
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- seasons
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.seasons TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.seasons
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- episodes
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.episodes TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.episodes
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- scenes
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.scenes TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.scenes
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- shots
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.shots TO stratifit_runtime;

CREATE POLICY "runtime_all" ON public.shots
  AS PERMISSIVE FOR ALL
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);
