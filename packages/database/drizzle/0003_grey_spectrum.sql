CREATE TABLE "org_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"organization_id" uuid,
	"team_id" uuid,
	"role" text,
	"status" text DEFAULT 'active' NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_memberships_role_check" CHECK ("org_memberships"."role" is null or "org_memberships"."role" in ('admin', 'operator', 'reviewer', 'viewer')),
	CONSTRAINT "org_memberships_status_check" CHECK ("org_memberships"."status" in ('active', 'inactive', 'suspended', 'revoked')),
	CONSTRAINT "org_memberships_scope_exactly_one_check" CHECK (num_nonnulls("org_memberships"."organization_id", "org_memberships"."team_id") = 1),
	CONSTRAINT "org_memberships_org_role_required_check" CHECK ("org_memberships"."team_id" is not null or "org_memberships"."role" is not null),
	CONSTRAINT "org_memberships_team_role_forbidden_check" CHECK ("org_memberships"."team_id" is null or "org_memberships"."role" is null),
	CONSTRAINT "org_memberships_revoked_at_check" CHECK (("org_memberships"."status" = 'revoked') = ("org_memberships"."revoked_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "org_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_org_slug_unique" UNIQUE("org_id","slug"),
	CONSTRAINT "teams_status_check" CHECK ("teams"."status" in ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_status_check";--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_granted_by_operators_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."operators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_org_memberships_operator" ON "org_memberships" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "idx_org_memberships_org" ON "org_memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_org_memberships_team" ON "org_memberships" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_memberships_org_nonrevoked_unique" ON "org_memberships" USING btree ("operator_id","organization_id") WHERE "org_memberships"."organization_id" is not null and "org_memberships"."status" <> 'revoked';--> statement-breakpoint
CREATE UNIQUE INDEX "org_memberships_team_nonrevoked_unique" ON "org_memberships" USING btree ("operator_id","team_id") WHERE "org_memberships"."team_id" is not null and "org_memberships"."status" <> 'revoked';--> statement-breakpoint
CREATE INDEX "idx_teams_org" ON "teams" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_status_check" CHECK ("organizations"."status" in ('active', 'suspended', 'archived'));