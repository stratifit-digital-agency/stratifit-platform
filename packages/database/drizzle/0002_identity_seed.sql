-- Stage 2.3 bootstrap seed (idempotent — ON CONFLICT DO NOTHING everywhere).
-- Seeds the default operating organization (approved D1 tenancy bootstrap) and
-- verification requirements as DATA, not code forks (DOMAIN_MODEL section 6).
-- No operator or audience rows are seeded: operators arrive via the approved
-- runbook; audience users are JIT-provisioned by services/identity.

INSERT INTO "organizations" ("slug", "name", "status")
VALUES ('stratifit', 'Stratifit', 'active')
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "verification_requirements" ("action", "required_verifications")
VALUES
  ('comment', ARRAY['email']::text[]),
  ('share', ARRAY['email']::text[]),
  ('message', ARRAY['email']::text[])
ON CONFLICT ("action") DO NOTHING;
