CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"organization_id" uuid,
	"correlation_id" text,
	"causation_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_action_check" CHECK ("audit_log"."action" <> ''),
	CONSTRAINT "audit_log_subject_kind_check" CHECK ("audit_log"."subject_kind" <> '')
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "idx_audit_log_org_time" ON "audit_log" USING btree ("organization_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_audit_log_subject" ON "audit_log" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "idx_audit_log_actor_time" ON "audit_log" USING btree ("actor_id","occurred_at" DESC NULLS LAST);