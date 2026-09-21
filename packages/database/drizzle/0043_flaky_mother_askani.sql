CREATE TABLE "rights_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"platforms" text[] NOT NULL,
	"territories" text[] NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"granted_by" uuid NOT NULL,
	"evidence_refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rights_grants_subject_kind_check" CHECK ("rights_grants"."subject_kind" in ('digital_human', 'character', 'persona', 'asset', 'production')),
	CONSTRAINT "rights_grants_scope_check" CHECK ("rights_grants"."scope" in ('generation', 'publication', 'advertising', 'messaging', 'derivative_creation')),
	CONSTRAINT "rights_grants_status_check" CHECK ("rights_grants"."status" in ('draft', 'active', 'expired', 'revoked', 'suspended')),
	CONSTRAINT "rights_grants_platforms_check" CHECK ("rights_grants"."platforms" <@ array['stratifit_media', 'youtube', 'tiktok', 'instagram', 'facebook', 'all']::text[] and cardinality("rights_grants"."platforms") between 1 and 6),
	CONSTRAINT "rights_grants_territories_check" CHECK (cardinality("rights_grants"."territories") between 1 and 50),
	CONSTRAINT "rights_grants_validity_window_check" CHECK ("rights_grants"."expires_at" is null or "rights_grants"."starts_at" is null or "rights_grants"."expires_at" > "rights_grants"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "rights_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rights_owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"contact_ref" text,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rights_owners_kind_check" CHECK ("rights_owners"."kind" in ('individual', 'organization')),
	CONSTRAINT "rights_owners_verification_check" CHECK ("rights_owners"."verification_status" in ('unverified', 'pending', 'verified', 'rejected')),
	CONSTRAINT "rights_owners_name_length_check" CHECK (char_length("rights_owners"."display_name") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "rights_owners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rights_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"reason" text,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rights_status_events_status_check" CHECK ("rights_status_events"."from_status" in ('draft', 'active', 'expired', 'revoked', 'suspended') and "rights_status_events"."to_status" in ('draft', 'active', 'expired', 'revoked', 'suspended'))
);
--> statement-breakpoint
ALTER TABLE "rights_status_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rights_grants" ADD CONSTRAINT "rights_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights_grants" ADD CONSTRAINT "rights_grants_owner_id_rights_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."rights_owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights_owners" ADD CONSTRAINT "rights_owners_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights_status_events" ADD CONSTRAINT "rights_status_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights_status_events" ADD CONSTRAINT "rights_status_events_grant_id_rights_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."rights_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_rights_grants_subject" ON "rights_grants" USING btree ("org_id","subject_kind","subject_id","scope");--> statement-breakpoint
CREATE INDEX "idx_rights_grants_owner" ON "rights_grants" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_rights_owners_org" ON "rights_owners" USING btree ("org_id","verification_status");--> statement-breakpoint
CREATE INDEX "idx_rights_status_events_grant" ON "rights_status_events" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_rights_status_events_org" ON "rights_status_events" USING btree ("org_id");