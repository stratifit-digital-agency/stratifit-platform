CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"content_ref" uuid NOT NULL,
	"parent_comment_id" uuid,
	"body" text NOT NULL,
	"visibility" text DEFAULT 'visible' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comments_visibility_check" CHECK ("comments"."visibility" in ('visible', 'hidden', 'removed')),
	CONSTRAINT "comments_body_length_check" CHECK (char_length("comments"."body") between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "follow_graph" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"follower_id" uuid NOT NULL,
	"followee_kind" text NOT NULL,
	"followee_audience_user_id" uuid,
	"followee_creator_profile_ref" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_graph_followee_kind_check" CHECK ("follow_graph"."followee_kind" in ('audience_user', 'creator_profile')),
	CONSTRAINT "follow_graph_followee_target_check" CHECK (("follow_graph"."followee_kind" = 'audience_user' and "follow_graph"."followee_audience_user_id" is not null and "follow_graph"."followee_creator_profile_ref" is null)
          or ("follow_graph"."followee_kind" = 'creator_profile' and "follow_graph"."followee_audience_user_id" is null and "follow_graph"."followee_creator_profile_ref" is not null)),
	CONSTRAINT "follow_graph_no_self_follow_check" CHECK ("follow_graph"."followee_kind" <> 'audience_user' or "follow_graph"."followee_audience_user_id" <> "follow_graph"."follower_id")
);
--> statement-breakpoint
ALTER TABLE "follow_graph" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "likes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"audience_user_id" uuid NOT NULL,
	"content_ref" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "likes_user_content_unique" UNIQUE("audience_user_id","content_ref")
);
--> statement-breakpoint
ALTER TABLE "likes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "saves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"audience_user_id" uuid NOT NULL,
	"content_ref" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saves_user_content_unique" UNIQUE("audience_user_id","content_ref")
);
--> statement-breakpoint
ALTER TABLE "saves" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"audience_user_id" uuid NOT NULL,
	"content_ref" uuid NOT NULL,
	"channel" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shares_channel_check" CHECK ("shares"."channel" in ('copy_link', 'external'))
);
--> statement-breakpoint
ALTER TABLE "shares" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_audience_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."audience_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_content_ref_public_content_id_fk" FOREIGN KEY ("content_ref") REFERENCES "public"."public_content"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_comment_id_comments_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."comments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_graph" ADD CONSTRAINT "follow_graph_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_graph" ADD CONSTRAINT "follow_graph_follower_id_audience_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."audience_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_graph" ADD CONSTRAINT "follow_graph_followee_audience_user_id_audience_users_id_fk" FOREIGN KEY ("followee_audience_user_id") REFERENCES "public"."audience_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_audience_user_id_audience_users_id_fk" FOREIGN KEY ("audience_user_id") REFERENCES "public"."audience_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_content_ref_public_content_id_fk" FOREIGN KEY ("content_ref") REFERENCES "public"."public_content"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saves" ADD CONSTRAINT "saves_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saves" ADD CONSTRAINT "saves_audience_user_id_audience_users_id_fk" FOREIGN KEY ("audience_user_id") REFERENCES "public"."audience_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saves" ADD CONSTRAINT "saves_content_ref_public_content_id_fk" FOREIGN KEY ("content_ref") REFERENCES "public"."public_content"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_audience_user_id_audience_users_id_fk" FOREIGN KEY ("audience_user_id") REFERENCES "public"."audience_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_content_ref_public_content_id_fk" FOREIGN KEY ("content_ref") REFERENCES "public"."public_content"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_comments_content_visibility" ON "comments" USING btree ("content_ref","visibility");--> statement-breakpoint
CREATE INDEX "idx_comments_author" ON "comments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "idx_comments_parent" ON "comments" USING btree ("parent_comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "follow_graph_audience_active_unique" ON "follow_graph" USING btree ("follower_id","followee_audience_user_id") WHERE "follow_graph"."followee_kind" = 'audience_user' and "follow_graph"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "follow_graph_creator_active_unique" ON "follow_graph" USING btree ("follower_id","followee_creator_profile_ref") WHERE "follow_graph"."followee_kind" = 'creator_profile' and "follow_graph"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_follow_graph_followee" ON "follow_graph" USING btree ("followee_kind","followee_audience_user_id");--> statement-breakpoint
CREATE INDEX "idx_follow_graph_follower" ON "follow_graph" USING btree ("follower_id");--> statement-breakpoint
CREATE INDEX "idx_likes_content" ON "likes" USING btree ("content_ref");--> statement-breakpoint
CREATE INDEX "idx_likes_user" ON "likes" USING btree ("audience_user_id");--> statement-breakpoint
CREATE INDEX "idx_saves_content" ON "saves" USING btree ("content_ref");--> statement-breakpoint
CREATE INDEX "idx_saves_user" ON "saves" USING btree ("audience_user_id");--> statement-breakpoint
CREATE INDEX "idx_shares_user" ON "shares" USING btree ("audience_user_id");--> statement-breakpoint
CREATE INDEX "idx_shares_content" ON "shares" USING btree ("content_ref");