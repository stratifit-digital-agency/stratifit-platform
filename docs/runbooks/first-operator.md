# First-Operator Runbook (Stage 2.2)

Approved context: D-4 — no bootstrap operator is seeded. The first operator and
its membership are created through this controlled runbook against the live
database. Every step runs as the migration/schema-owner role
(`DATABASE_MIGRATE_URL`); the runtime role cannot create operators by design.

## Preconditions

- `.env` exists at the repo root with `DATABASE_MIGRATE_URL` (never committed).
- A Supabase Auth user already exists for the operator (Dashboard →
  Authentication → Add user). Copy that user's `id` — it is the
  `auth_subject_ref`.

## Step 1 — Create the operator row (migrator connection only)

```bash
cd packages/database
set -a; . ../../.env; set +a
node --input-type=module - <<'EOF'
import postgres from "postgres";
import { readFileSync } from "node:fs";
const url = readFileSync("../../.env", "utf8").match(/^DATABASE_MIGRATE_URL=(.+)$/m)[1].trim();
const sql = postgres(url, { prepare: false, max: 1 });

const SUBJECT = "<supabase-auth-user-id>";           // <-- replace
const EMAIL   = "<operator email>";                   // <-- replace

const [org] = await sql`select id from organizations where slug = 'stratifit'`;
if (!org) throw new Error("seed organization 'stratifit' missing");

const [op] = await sql`
  insert into operators (org_id, auth_subject_ref, email, display_name, status)
  values (${org.id}, ${SUBJECT}, ${EMAIL}, ${EMAIL}, 'active')
  on conflict (auth_subject_ref) do update set updated_at = now()
  returning id, email`;
console.log("operator:", op.id, op.email);

// Step 2 — Grant the initial admin org membership (sole authorization source, D-1)
const [m] = await sql`
  insert into org_memberships (operator_id, organization_id, role, status, granted_at)
  values (${op.id}, ${org.id}, 'admin', 'active', now())
  on conflict do nothing
  returning id, role`;
console.log("membership:", m?.id ?? "(already present)", m?.role ?? "");

await sql.end();
EOF
```

## Step 3 — Verify the authorization chain

```bash
# Sign in through Control (/login), then load /admin:
#   the page must render the operator email, roles: admin, and the full
#   capability list. A subject with NO active membership must still be
#   redirected by the middleware gate and resolve to null (fail closed, D-2).
```

## Notes

- `operators.roles` stays empty/deprecated: it is never consulted for
  authorization (D-1). Leave it `'{}'`.
- Further operators: create the `operators` row the same way, then grant their
  membership through the membership service (capability `admin.permissions`),
  NOT directly in SQL — grants must flow through the audited command path.
- Never insert `org_memberships` rows with the runtime role connection in
  production; the runbook path is the controlled exception for operator 1.
