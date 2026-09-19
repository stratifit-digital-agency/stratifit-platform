CREATE TABLE "distribution_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"platform_target" text NOT NULL,
	"external_ref" text,
	"status" text NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "distribution_references_status_check" CHECK ("distribution_references"."status" in ('succeeded', 'failed')),
	CONSTRAINT "distribution_references_platform_target_check" CHECK ("distribution_references"."platform_target" in ('stratifit-media', 'youtube', 'tiktok', 'instagram', 'facebook'))
);
--> statement-breakpoint
ALTER TABLE "distribution_references" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "publication_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"title" text NOT NULL,
	"synopsis" text,
	"qc_review_id" uuid,
	"subject_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"platform_target" text NOT NULL,
	"content_type" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_versions_pub_version_unique" UNIQUE("publication_id","version_number"),
	CONSTRAINT "publication_versions_version_positive_check" CHECK ("publication_versions"."version_number" > 0),
	CONSTRAINT "publication_versions_platform_target_check" CHECK ("publication_versions"."platform_target" in ('stratifit-media', 'youtube', 'tiktok', 'instagram', 'facebook')),
	CONSTRAINT "publication_versions_content_type_check" CHECK ("publication_versions"."content_type" in ('film', 'series', 'episode', 'short', 'music', 'documentary', 'trailer'))
);
--> statement-breakpoint
ALTER TABLE "publication_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_ref" uuid NOT NULL,
	"platform_target" text NOT NULL,
	"content_type" text NOT NULL,
	"current_version_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_failure_reason" text,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publications_org_subject_platform_unique" UNIQUE("org_id","subject_kind","subject_ref","platform_target"),
	CONSTRAINT "publications_subject_kind_check" CHECK ("publications"."subject_kind" in ('production', 'asset_version', 'ai_creator_profile', 'campaign_creative')),
	CONSTRAINT "publications_platform_target_check" CHECK ("publications"."platform_target" in ('stratifit-media', 'youtube', 'tiktok', 'instagram', 'facebook')),
	CONSTRAINT "publications_content_type_check" CHECK ("publications"."content_type" in ('film', 'series', 'episode', 'short', 'music', 'documentary', 'trailer')),
	CONSTRAINT "publications_status_check" CHECK ("publications"."status" in ('draft', 'pending_approval', 'approved', 'scheduled', 'publishing', 'published', 'unpublished', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "publications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "distribution_references" ADD CONSTRAINT "distribution_references_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_references" ADD CONSTRAINT "distribution_references_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_references" ADD CONSTRAINT "distribution_references_version_id_publication_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."publication_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_versions" ADD CONSTRAINT "publication_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_versions" ADD CONSTRAINT "publication_versions_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_distribution_references_org_pub" ON "distribution_references" USING btree ("org_id","publication_id");--> statement-breakpoint
CREATE INDEX "idx_publication_versions_org_pub" ON "publication_versions" USING btree ("org_id","publication_id");--> statement-breakpoint
CREATE INDEX "idx_publications_org_status" ON "publications" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_publications_org_subject" ON "publications" USING btree ("org_id","subject_kind","subject_ref");