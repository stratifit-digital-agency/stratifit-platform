CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"creator_profile_id" uuid NOT NULL,
	"audience_user_id" uuid NOT NULL,
	"subject" text,
	"status" text DEFAULT 'open' NOT NULL,
	"audience_unread_count" integer DEFAULT 0 NOT NULL,
	"creator_unread_count" integer DEFAULT 0 NOT NULL,
	"audience_last_read_message_id" uuid,
	"creator_last_read_message_id" uuid,
	"lead_id" uuid,
	"assigned_operator_id" uuid,
	"taken_over_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_status_check" CHECK ("conversations"."status" in ('open', 'awaiting_ai', 'active', 'awaiting_human', 'closed')),
	CONSTRAINT "conversations_subject_length_check" CHECK ("conversations"."subject" is null or char_length("conversations"."subject") between 1 and 200),
	CONSTRAINT "conversations_audience_unread_check" CHECK ("conversations"."audience_unread_count" >= 0),
	CONSTRAINT "conversations_creator_unread_check" CHECK ("conversations"."creator_unread_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "lead_follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_follow_ups_note_length_check" CHECK (char_length("lead_follow_ups"."note") between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "lead_follow_ups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_kind" text NOT NULL,
	"author_audience_user_id" uuid,
	"author_operator_id" uuid,
	"author_ai_creator_id" uuid,
	"message_type" text DEFAULT 'message' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_author_kind_check" CHECK ("messages"."author_kind" in ('ai', 'human', 'system')),
	CONSTRAINT "messages_message_type_check" CHECK ("messages"."message_type" in ('message', 'service_inquiry', 'system_notice')),
	CONSTRAINT "messages_body_length_check" CHECK (char_length("messages"."body") between 1 and 4000),
	CONSTRAINT "messages_author_consistency_check" CHECK ((
        (author_kind = 'human' and ((author_audience_user_id is not null)::int + (author_operator_id is not null)::int = 1) and author_ai_creator_id is null)
        or (author_kind = 'ai' and author_ai_creator_id is not null and author_audience_user_id is null and author_operator_id is null)
        or (author_kind = 'system' and author_audience_user_id is null and author_operator_id is null and author_ai_creator_id is null)
      ))
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "service_inquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"classification" text NOT NULL,
	"confidence" numeric(3, 2),
	"requested_service_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_inquiries_message_unique" UNIQUE("message_id"),
	CONSTRAINT "service_inquiries_status_check" CHECK ("service_inquiries"."status" in ('open', 'converted', 'dismissed')),
	CONSTRAINT "service_inquiries_classification_length_check" CHECK (char_length("service_inquiries"."classification") between 1 and 200),
	CONSTRAINT "service_inquiries_confidence_check" CHECK ("service_inquiries"."confidence" is null or ("service_inquiries"."confidence" >= 0 and "service_inquiries"."confidence" <= 1))
);
--> statement-breakpoint
ALTER TABLE "service_inquiries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "service_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"creator_profile_id" uuid NOT NULL,
	"audience_user_id" uuid NOT NULL,
	"service_inquiry_id" uuid NOT NULL,
	"classification" text,
	"requested_service_id" uuid,
	"status" text DEFAULT 'new' NOT NULL,
	"assigned_operator_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_leads_status_check" CHECK ("service_leads"."status" in ('new', 'triaged', 'assigned', 'in_progress', 'won', 'lost', 'archived')),
	CONSTRAINT "service_leads_classification_length_check" CHECK ("service_leads"."classification" is null or char_length("service_leads"."classification") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "service_leads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "service_offerings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ai_creator_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_offerings_org_creator_name_unique" UNIQUE("org_id","ai_creator_id","name"),
	CONSTRAINT "service_offerings_status_check" CHECK ("service_offerings"."status" in ('active', 'retired')),
	CONSTRAINT "service_offerings_name_length_check" CHECK (char_length("service_offerings"."name") between 1 and 200),
	CONSTRAINT "service_offerings_category_length_check" CHECK ("service_offerings"."category" is null or char_length("service_offerings"."category") between 1 and 100),
	CONSTRAINT "service_offerings_description_length_check" CHECK ("service_offerings"."description" is null or char_length("service_offerings"."description") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "service_offerings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_creator_profile_id_creator_profiles_id_fk" FOREIGN KEY ("creator_profile_id") REFERENCES "public"."creator_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_audience_user_id_audience_users_id_fk" FOREIGN KEY ("audience_user_id") REFERENCES "public"."audience_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_audience_last_read_message_id_messages_id_fk" FOREIGN KEY ("audience_last_read_message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_creator_last_read_message_id_messages_id_fk" FOREIGN KEY ("creator_last_read_message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_follow_ups" ADD CONSTRAINT "lead_follow_ups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_follow_ups" ADD CONSTRAINT "lead_follow_ups_lead_id_service_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."service_leads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_follow_ups" ADD CONSTRAINT "lead_follow_ups_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_inquiries" ADD CONSTRAINT "service_inquiries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_inquiries" ADD CONSTRAINT "service_inquiries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_inquiries" ADD CONSTRAINT "service_inquiries_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_inquiries" ADD CONSTRAINT "service_inquiries_requested_service_id_service_offerings_id_fk" FOREIGN KEY ("requested_service_id") REFERENCES "public"."service_offerings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_leads" ADD CONSTRAINT "service_leads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_leads" ADD CONSTRAINT "service_leads_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_leads" ADD CONSTRAINT "service_leads_creator_profile_id_creator_profiles_id_fk" FOREIGN KEY ("creator_profile_id") REFERENCES "public"."creator_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_leads" ADD CONSTRAINT "service_leads_audience_user_id_audience_users_id_fk" FOREIGN KEY ("audience_user_id") REFERENCES "public"."audience_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_leads" ADD CONSTRAINT "service_leads_service_inquiry_id_service_inquiries_id_fk" FOREIGN KEY ("service_inquiry_id") REFERENCES "public"."service_inquiries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_leads" ADD CONSTRAINT "service_leads_requested_service_id_service_offerings_id_fk" FOREIGN KEY ("requested_service_id") REFERENCES "public"."service_offerings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_offerings" ADD CONSTRAINT "service_offerings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_offerings" ADD CONSTRAINT "service_offerings_ai_creator_id_ai_creators_id_fk" FOREIGN KEY ("ai_creator_id") REFERENCES "public"."ai_creators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_open_pair_unique" ON "conversations" USING btree ("audience_user_id","creator_profile_id") WHERE status <> 'closed';--> statement-breakpoint
CREATE INDEX "idx_conversations_org_status" ON "conversations" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_conversations_creator_profile" ON "conversations" USING btree ("creator_profile_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_audience_user" ON "conversations" USING btree ("audience_user_id");--> statement-breakpoint
CREATE INDEX "idx_lead_follow_ups_lead" ON "lead_follow_ups" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_lead_follow_ups_org" ON "lead_follow_ups" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_messages_conversation_created" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_messages_org" ON "messages" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_service_inquiries_conversation" ON "service_inquiries" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_service_inquiries_org_status" ON "service_inquiries" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_service_leads_org_status" ON "service_leads" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_service_leads_conversation" ON "service_leads" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_service_leads_assigned_operator" ON "service_leads" USING btree ("assigned_operator_id");--> statement-breakpoint
CREATE INDEX "idx_service_offerings_org_status" ON "service_offerings" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_service_offerings_ai_creator" ON "service_offerings" USING btree ("ai_creator_id");