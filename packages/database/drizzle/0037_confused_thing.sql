CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"audience_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_kind" text,
	"source_ref" uuid,
	"event_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('conversation_reply')),
	CONSTRAINT "notifications_source_kind_check" CHECK ("notifications"."source_kind" is null or "notifications"."source_kind" in ('conversation'))
);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_audience_user_id_audience_users_id_fk" FOREIGN KEY ("audience_user_id") REFERENCES "public"."audience_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notifications_owner_created" ON "notifications" USING btree ("audience_user_id","created_at" DESC NULLS LAST);