CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"content_ref" uuid,
	"org_id" uuid,
	"audience_user_id" uuid,
	"session_hash" text NOT NULL,
	"properties" jsonb,
	"client_ts" timestamp with time zone,
	"server_ts" timestamp with time zone DEFAULT now() NOT NULL,
	"ingest_event_id" text NOT NULL,
	CONSTRAINT "analytics_events_ingest_event_id_unique" UNIQUE("ingest_event_id"),
	CONSTRAINT "analytics_events_event_type_check" CHECK ("analytics_events"."event_type" in ('content_view', 'content_progress', 'content_complete', 'content_share')),
	CONSTRAINT "analytics_events_session_hash_check" CHECK (char_length("analytics_events"."session_hash") = 64)
);
--> statement-breakpoint
ALTER TABLE "analytics_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_content_ref_public_content_id_fk" FOREIGN KEY ("content_ref") REFERENCES "public"."public_content"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_audience_user_id_audience_users_id_fk" FOREIGN KEY ("audience_user_id") REFERENCES "public"."audience_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_analytics_content_ts" ON "analytics_events" USING btree ("content_ref","server_ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_analytics_type_ts" ON "analytics_events" USING btree ("event_type","server_ts" DESC NULLS LAST);