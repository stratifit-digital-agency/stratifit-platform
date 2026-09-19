CREATE TABLE "watch_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"audience_user_id" uuid NOT NULL,
	"content_ref" uuid NOT NULL,
	"position_seconds" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_progress_user_content_unique" UNIQUE("audience_user_id","content_ref"),
	CONSTRAINT "watch_progress_position_check" CHECK ("watch_progress"."position_seconds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "watch_progress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "watch_progress" ADD CONSTRAINT "watch_progress_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_progress" ADD CONSTRAINT "watch_progress_audience_user_id_audience_users_id_fk" FOREIGN KEY ("audience_user_id") REFERENCES "public"."audience_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_progress" ADD CONSTRAINT "watch_progress_content_ref_public_content_id_fk" FOREIGN KEY ("content_ref") REFERENCES "public"."public_content"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_watch_progress_content" ON "watch_progress" USING btree ("content_ref");