CREATE TABLE "audience_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"auth_subject_ref" text NOT NULL,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"handle" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audience_users_auth_subject_ref_unique" UNIQUE("auth_subject_ref"),
	CONSTRAINT "audience_users_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
ALTER TABLE "audience_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"auth_subject_ref" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operators_auth_subject_ref_unique" UNIQUE("auth_subject_ref"),
	CONSTRAINT "operators_roles_subset_check" CHECK ("operators"."roles" <@ array['admin', 'operator', 'reviewer', 'viewer']::text[])
);
--> statement-breakpoint
ALTER TABLE "operators" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organizations_status_check" CHECK ("organizations"."status" in ('active', 'suspended'))
);
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "verification_requirements" (
	"action" text PRIMARY KEY NOT NULL,
	"required_verifications" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verification_requirements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audience_users" ADD CONSTRAINT "audience_users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audience_users_org" ON "audience_users" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_operators_org" ON "operators" USING btree ("org_id");