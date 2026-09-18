-- Stage 2.7 blocker-resolution migration (approved Option B + trigger fix).
--
-- BLOCKER 1: the Stage 2.7 security freeze live-proved that
-- public.enforce_job_dependency_same_org had an INVERTED predicate:
--   same-org pair   -> REJECTED (P0001)   [wrong: must accept]
--   cross-org pair  -> ACCEPTED           [wrong: must reject]
-- `GROUP BY org_id HAVING count(*) <> 1` sees one group of 2 for a same-org
-- pair and two groups of 1 for a cross-org pair — exactly backwards. 0013 is
-- already-applied migration history and stays untouched; this forward-only
-- migration replaces the function body with the approved distinct-org
-- predicate. Same-org pair -> 1 distinct org -> accept; cross-org pair ->
-- 2 distinct orgs -> reject; missing endpoint -> 1 distinct org -> accept,
-- then the FK raises as before. Posture is unchanged: owner stratifit_app,
-- SECURITY INVOKER, static SQL, no dynamic EXECUTE, no grants introduced.
--
-- BLOCKER 2 (approved Option B): job_attempts stays INSERT+SELECT ONLY for
-- stratifit_runtime (NO UPDATE, NO DELETE — grants and RLS unchanged), while
-- two narrowly scoped SECURITY DEFINER functions perform the ONLY mutation
-- channels:
--   close_job_attempt(org, attempt, ...)          — one-shot terminal transition of an
--                                     OPEN attempt, org-scoped.
--   record_job_attempt_progress(org, attempt, ..) — progress_snapshot only, open
--                                     attempts only, org-scoped.
-- Security hardening (first SECURITY DEFINER usage in the platform):
--   - SECURITY DEFINER, owned by stratifit_app (the migrator/table owner)
--   - SET search_path = '' : every object/function reference is fully
--     qualified, so a hijacked search_path cannot redirect resolution
--   - static SQL only; bound parameters; no dynamic EXECUTE
--   - return void; no arbitrary data egress
--   - REVOKE EXECUTE FROM PUBLIC; GRANT EXECUTE only to stratifit_runtime
-- The functions update only the approved mutable attempt attributes and can
-- never touch a CLOSED attempt (one-shot guard: WHERE completed_at IS NULL),
-- so execution history cannot be rewritten even by the definer path. Both
-- functions ALSO carry an explicit org_id predicate: the caller must present
-- the attempt's organization, so the definer channel can NEVER mutate
-- another organization's attempt even though runtime's role-gate RLS can
-- read attempt ids across orgs (approved service-level isolation model —
-- the definer seam is strictly NARROWER, not broader).
--
-- Rollback (reverse-SQL):
--   REVOKE EXECUTE ON FUNCTION public.close_job_attempt(uuid, uuid, text, text, jsonb, uuid) FROM stratifit_runtime;
--   GRANT EXECUTE ON FUNCTION public.close_job_attempt(uuid, uuid, text, text, jsonb, uuid) TO PUBLIC;
--   REVOKE EXECUTE ON FUNCTION public.record_job_attempt_progress(uuid, uuid, jsonb) FROM stratifit_runtime;
--   GRANT EXECUTE ON FUNCTION public.record_job_attempt_progress(uuid, uuid, jsonb) TO PUBLIC;
--   DROP FUNCTION public.record_job_attempt_progress(uuid, jsonb);
--   DROP FUNCTION public.close_job_attempt(uuid, text, text, jsonb, uuid);
--   (0013's inverted trigger predicate is intentionally NOT restored.)

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.enforce_job_dependency_same_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(DISTINCT j.org_id) FROM public.jobs j
      WHERE j.id IN (NEW.job_id, NEW.depends_on_job_id)) > 1 THEN
    RAISE EXCEPTION 'job dependency endpoints must belong to a single organization';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.close_job_attempt(
  p_org_id uuid,
  p_attempt_id uuid,
  p_outcome text,
  p_error_detail text,
  p_progress jsonb,
  p_usage_record_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- Outcome must be a terminal attempt outcome (DM section 16).
  IF p_outcome NOT IN ('succeeded', 'failed', 'timed_out', 'cancelled') THEN
    RAISE EXCEPTION 'invalid attempt outcome';
  END IF;
  -- COALESCE is parser syntax (not schema-qualifiable), so the NULL guard
  -- uses CASE — required for correctness under SET search_path = ''.
  UPDATE public.job_attempts SET
    completed_at = pg_catalog.now(),
    outcome = p_outcome,
    error_detail = p_error_detail,
    progress_snapshot = CASE WHEN p_progress IS NULL THEN '{}'::pg_catalog.jsonb ELSE p_progress END,
    usage_record_id = p_usage_record_id
  WHERE id = p_attempt_id
    AND org_id = p_org_id
    AND completed_at IS NULL; -- one-shot + org guard: a CLOSED attempt, or an attempt of a DIFFERENT organization, can never be modified
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no open attempt % in organization %', p_attempt_id, p_org_id;
  END IF;
  RETURN;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.record_job_attempt_progress(
  p_org_id uuid,
  p_attempt_id uuid,
  p_progress jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.job_attempts SET
    progress_snapshot = CASE WHEN p_progress IS NULL THEN '{}'::pg_catalog.jsonb ELSE p_progress END
  WHERE id = p_attempt_id
    AND org_id = p_org_id
    AND completed_at IS NULL; -- progress only on an OPEN attempt of the caller's organization
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no open attempt % in organization %', p_attempt_id, p_org_id;
  END IF;
  RETURN;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.close_job_attempt(uuid, uuid, text, text, jsonb, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.record_job_attempt_progress(uuid, uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.close_job_attempt(uuid, uuid, text, text, jsonb, uuid) TO stratifit_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_job_attempt_progress(uuid, uuid, jsonb) TO stratifit_runtime;
--> statement-breakpoint
-- Build-session reconciliation: an interim signature of these functions
-- (without the org predicate) was applied earlier in THIS build and is
-- superseded here; drop it so the EXECUTE surface is exactly the two final
-- org-scoped functions.
DROP FUNCTION IF EXISTS public.close_job_attempt(uuid, text, text, jsonb, uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.record_job_attempt_progress(uuid, jsonb);
