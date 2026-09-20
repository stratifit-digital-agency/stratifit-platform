CREATE TABLE "ai_creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"communication_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_ai" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_creators_org_handle_unique" UNIQUE("org_id","handle"),
	CONSTRAINT "ai_creators_status_check" CHECK ("ai_creators"."status" in ('draft', 'active', 'paused', 'retired')),
	CONSTRAINT "ai_creators_handle_shape_check" CHECK ("ai_creators"."handle" ~ '^[a-z0-9-]{3,64}$'),
	CONSTRAINT "ai_creators_is_ai_check" CHECK ("ai_creators"."is_ai" = true)
);
--> statement-breakpoint
ALTER TABLE "ai_creators" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"digital_human_id" uuid,
	"name" text NOT NULL,
	"bio" text,
	"visual_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "characters_status_check" CHECK ("characters"."status" in ('draft', 'active', 'retired'))
);
--> statement-breakpoint
ALTER TABLE "characters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "creator_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ai_creator_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"publication_version_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"bio" text,
	"personality_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"interests_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"avatar_ref" uuid,
	"poster_ref" uuid,
	"messaging_enabled" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creator_profiles_publication_version_unique" UNIQUE("publication_version_id"),
	CONSTRAINT "creator_profiles_status_check" CHECK ("creator_profiles"."status" in ('active', 'paused', 'unpublished')),
	CONSTRAINT "creator_profiles_handle_shape_check" CHECK ("creator_profiles"."handle" ~ '^[a-z0-9-]{3,64}$')
);
--> statement-breakpoint
ALTER TABLE "creator_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "digital_humans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"appearance_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"base_model_version_ref" uuid,
	"base_workflow_version_ref" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digital_humans_status_check" CHECK ("digital_humans"."status" in ('draft', 'active', 'retired'))
);
--> statement-breakpoint
ALTER TABLE "digital_humans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"character_id" uuid NOT NULL,
	"name" text NOT NULL,
	"personality" text,
	"interests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"behavior_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personas_status_check" CHECK ("personas"."status" in ('draft', 'active', 'retired'))
);
--> statement-breakpoint
ALTER TABLE "personas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_creators" ADD CONSTRAINT "ai_creators_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_creators" ADD CONSTRAINT "ai_creators_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_digital_human_id_digital_humans_id_fk" FOREIGN KEY ("digital_human_id") REFERENCES "public"."digital_humans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_profiles" ADD CONSTRAINT "creator_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_profiles" ADD CONSTRAINT "creator_profiles_ai_creator_id_ai_creators_id_fk" FOREIGN KEY ("ai_creator_id") REFERENCES "public"."ai_creators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_profiles" ADD CONSTRAINT "creator_profiles_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_profiles" ADD CONSTRAINT "creator_profiles_publication_version_id_publication_versions_id_fk" FOREIGN KEY ("publication_version_id") REFERENCES "public"."publication_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_humans" ADD CONSTRAINT "digital_humans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_creators_org_status" ON "ai_creators" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_ai_creators_persona" ON "ai_creators" USING btree ("persona_id");--> statement-breakpoint
CREATE INDEX "idx_characters_org_status" ON "characters" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_characters_digital_human" ON "characters" USING btree ("digital_human_id");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_profiles_org_creator_unique" ON "creator_profiles" USING btree ("org_id","ai_creator_id") WHERE status <> 'unpublished';--> statement-breakpoint
CREATE UNIQUE INDEX "creator_profiles_org_handle_unique" ON "creator_profiles" USING btree ("org_id","handle") WHERE status <> 'unpublished';--> statement-breakpoint
CREATE INDEX "idx_creator_profiles_org_status" ON "creator_profiles" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_creator_profiles_ai_creator" ON "creator_profiles" USING btree ("ai_creator_id");--> statement-breakpoint
CREATE INDEX "idx_digital_humans_org_status" ON "digital_humans" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_personas_org_status" ON "personas" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_personas_character" ON "personas" USING btree ("character_id");