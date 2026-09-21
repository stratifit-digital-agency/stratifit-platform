CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"season_id" uuid,
	"story_id" uuid,
	"production_id" uuid,
	"episode_number" integer NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "episodes_status_check" CHECK ("episodes"."status" in ('draft', 'active', 'retired')),
	CONSTRAINT "episodes_title_length_check" CHECK (char_length("episodes"."title") between 1 and 300),
	CONSTRAINT "episodes_number_positive_check" CHECK ("episodes"."episode_number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "episodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"story_id" uuid,
	"episode_id" uuid,
	"production_id" uuid,
	"order_index" integer NOT NULL,
	"title" text NOT NULL,
	"synopsis" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scenes_status_check" CHECK ("scenes"."status" in ('draft', 'active', 'retired')),
	CONSTRAINT "scenes_title_length_check" CHECK (char_length("scenes"."title") between 1 and 300),
	CONSTRAINT "scenes_order_nonnegative_check" CHECK ("scenes"."order_index" >= 0)
);
--> statement-breakpoint
ALTER TABLE "scenes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"season_number" integer NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seasons_story_number_unique" UNIQUE("story_id","season_number"),
	CONSTRAINT "seasons_status_check" CHECK ("seasons"."status" in ('draft', 'active', 'retired')),
	CONSTRAINT "seasons_title_length_check" CHECK (char_length("seasons"."title") between 1 and 300),
	CONSTRAINT "seasons_number_positive_check" CHECK ("seasons"."season_number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "seasons" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scene_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"description" text NOT NULL,
	"aspect" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"fps" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shots_scene_order_unique" UNIQUE("scene_id","order_index"),
	CONSTRAINT "shots_status_check" CHECK ("shots"."status" in ('draft', 'active', 'retired')),
	CONSTRAINT "shots_description_length_check" CHECK (char_length("shots"."description") between 1 and 2000),
	CONSTRAINT "shots_order_nonnegative_check" CHECK ("shots"."order_index" >= 0),
	CONSTRAINT "shots_aspect_shape_check" CHECK (char_length("shots"."aspect") between 1 and 20),
	CONSTRAINT "shots_duration_positive_check" CHECK ("shots"."duration_seconds" > 0),
	CONSTRAINT "shots_fps_range_check" CHECK ("shots"."fps" between 1 and 240)
);
--> statement-breakpoint
ALTER TABLE "shots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"world_id" uuid,
	"universe_id" uuid,
	"title" text NOT NULL,
	"logline" text NOT NULL,
	"kind" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stories_status_check" CHECK ("stories"."status" in ('draft', 'active', 'completed', 'retired')),
	CONSTRAINT "stories_kind_check" CHECK ("stories"."kind" in ('film', 'series', 'short', 'campaign_narrative')),
	CONSTRAINT "stories_title_length_check" CHECK (char_length("stories"."title") between 1 and 300),
	CONSTRAINT "stories_logline_length_check" CHECK (char_length("stories"."logline") between 1 and 1000),
	CONSTRAINT "stories_version_positive_check" CHECK ("stories"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "stories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "universes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "universes_org_slug_unique" UNIQUE("org_id","slug"),
	CONSTRAINT "universes_status_check" CHECK ("universes"."status" in ('draft', 'active', 'retired')),
	CONSTRAINT "universes_name_length_check" CHECK (char_length("universes"."name") between 1 and 200),
	CONSTRAINT "universes_slug_shape_check" CHECK ("universes"."slug" ~ '^[a-z0-9-]{3,64}$')
);
--> statement-breakpoint
ALTER TABLE "universes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "worlds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"universe_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worlds_status_check" CHECK ("worlds"."status" in ('draft', 'active', 'retired')),
	CONSTRAINT "worlds_name_length_check" CHECK (char_length("worlds"."name") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "worlds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_production_id_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."productions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_production_id_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."productions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shots" ADD CONSTRAINT "shots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shots" ADD CONSTRAINT "shots_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "universes" ADD CONSTRAINT "universes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worlds" ADD CONSTRAINT "worlds_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worlds" ADD CONSTRAINT "worlds_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "episodes_season_number_unique" ON "episodes" USING btree ("season_id","episode_number") WHERE season_id is not null;--> statement-breakpoint
CREATE INDEX "idx_episodes_org_status" ON "episodes" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_episodes_season" ON "episodes" USING btree ("season_id");--> statement-breakpoint
CREATE INDEX "idx_episodes_story" ON "episodes" USING btree ("story_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scenes_episode_order_unique" ON "scenes" USING btree ("episode_id","order_index") WHERE episode_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "scenes_story_order_unique" ON "scenes" USING btree ("story_id","order_index") WHERE story_id is not null and episode_id is null;--> statement-breakpoint
CREATE INDEX "idx_scenes_org_status" ON "scenes" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_scenes_story" ON "scenes" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "idx_scenes_episode" ON "scenes" USING btree ("episode_id");--> statement-breakpoint
CREATE INDEX "idx_seasons_org_status" ON "seasons" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_seasons_story" ON "seasons" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "idx_shots_org_status" ON "shots" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_shots_scene" ON "shots" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "idx_stories_org_status" ON "stories" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_stories_world" ON "stories" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "idx_stories_universe" ON "stories" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "idx_universes_org_status" ON "universes" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_worlds_org_status" ON "worlds" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_worlds_universe" ON "worlds" USING btree ("universe_id");