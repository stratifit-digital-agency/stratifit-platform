-- Stage 2.22 (D2.22-1): rights_requirements — the declarations family that
-- makes a future Rights port cutover principled. NOTHING consumes it in this
-- stage (D2.22-SELECT: cutover deferred to Stage 2.23).
--
-- Mutable ARWD family to the runtime role; RLS with exactly one runtime_all
-- policy; zero PUBLIC grants (house pattern, mirrors 0042/0044).

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rights_requirements TO stratifit_runtime;

CREATE POLICY runtime_all ON public.rights_requirements
  TO stratifit_runtime
  USING (true)
  WITH CHECK (true);
