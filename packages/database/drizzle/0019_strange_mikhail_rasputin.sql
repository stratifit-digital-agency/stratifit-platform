CREATE TABLE "asset_lineage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"parent_version_id" uuid NOT NULL,
	"child_version_id" uuid NOT NULL,
	"derivation_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_lineage_edge_unique" UNIQUE("parent_version_id","child_version_id"),
	CONSTRAINT "asset_lineage_derivation_kind_check" CHECK ("asset_lineage"."derivation_kind" in ('generation', 'edit', 'transcode', 'thumbnail', 'trailer', 'upscale', 'enhancement')),
	CONSTRAINT "asset_lineage_no_self_edge_check" CHECK ("asset_lineage"."parent_version_id" <> "asset_lineage"."child_version_id")
);
--> statement-breakpoint
ALTER TABLE "asset_lineage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "asset_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"bucket" text NOT NULL,
	"storage_key" text NOT NULL,
	"checksum" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"mime_type" text NOT NULL,
	"technical_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance_generation_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_versions_org_asset_version_unique" UNIQUE("org_id","asset_id","version_number")
);
--> statement-breakpoint
ALTER TABLE "asset_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subtype" text,
	"title" text NOT NULL,
	"description" text,
	"current_version_id" uuid,
	"approval_state" text DEFAULT 'pending' NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"production_id" uuid,
	"shot_id" uuid,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_kind_check" CHECK ("assets"."kind" in ('video', 'audio', 'image', 'document', 'subtitle', 'data')),
	CONSTRAINT "assets_subtype_check" CHECK ("assets"."subtype" is null or "assets"."subtype" in ('master', 'derivative', 'thumbnail', 'poster', 'trailer', 'clip', 'sample', 'subtitle', 'lyrics', 'caption', 'document')),
	CONSTRAINT "assets_approval_state_check" CHECK ("assets"."approval_state" in ('pending', 'in_review', 'approved', 'rejected')),
	CONSTRAINT "assets_visibility_check" CHECK ("assets"."visibility" in ('internal', 'public'))
);
--> statement-breakpoint
ALTER TABLE "assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "asset_lineage" ADD CONSTRAINT "asset_lineage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_lineage" ADD CONSTRAINT "asset_lineage_parent_version_id_asset_versions_id_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_lineage" ADD CONSTRAINT "asset_lineage_child_version_id_asset_versions_id_fk" FOREIGN KEY ("child_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_asset_lineage_org_child" ON "asset_lineage" USING btree ("org_id","child_version_id");--> statement-breakpoint
CREATE INDEX "idx_asset_versions_org_asset" ON "asset_versions" USING btree ("org_id","asset_id");--> statement-breakpoint
CREATE INDEX "idx_assets_org_kind" ON "assets" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "idx_assets_org_status" ON "assets" USING btree ("org_id","approval_state");--> statement-breakpoint
CREATE INDEX "idx_assets_org_production" ON "assets" USING btree ("org_id","production_id");