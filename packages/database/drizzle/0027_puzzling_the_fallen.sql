CREATE TABLE "public_content" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"publication_version_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"content_type" text NOT NULL,
	"title" text NOT NULL,
	"synopsis" text,
	"media_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"duration_seconds" integer,
	"creator_profile_ref" uuid,
	"series_ref" uuid,
	"episode_number" integer,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_content_slug_unique" UNIQUE("slug"),
	CONSTRAINT "public_content_publication_version_unique" UNIQUE("publication_version_id"),
	CONSTRAINT "public_content_content_type_check" CHECK ("public_content"."content_type" in ('film', 'movie', 'series', 'episode', 'short', 'comedy', 'skit', 'music', 'music-video', 'documentary', 'live-program', 'trailer', 'advertisement')),
	CONSTRAINT "public_content_status_check" CHECK ("public_content"."status" in ('published', 'unpublished')),
	CONSTRAINT "public_content_duration_check" CHECK ("public_content"."duration_seconds" is null or "public_content"."duration_seconds" >= 0),
	CONSTRAINT "public_content_episode_number_check" CHECK ("public_content"."episode_number" is null or "public_content"."episode_number" >= 0)
);
--> statement-breakpoint
ALTER TABLE "public_content" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public_content" ADD CONSTRAINT "public_content_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_content" ADD CONSTRAINT "public_content_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_content" ADD CONSTRAINT "public_content_publication_version_id_publication_versions_id_fk" FOREIGN KEY ("publication_version_id") REFERENCES "public"."publication_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_public_content_org_status" ON "public_content" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_public_content_publication" ON "public_content" USING btree ("publication_id");