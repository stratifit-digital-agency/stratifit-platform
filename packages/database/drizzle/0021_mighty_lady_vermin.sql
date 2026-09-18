CREATE TABLE "qc_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"applies_to_kind" text NOT NULL,
	"check_type" text NOT NULL,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qc_checks_org_name_unique" UNIQUE("org_id","name"),
	CONSTRAINT "qc_checks_applies_to_kind_check" CHECK ("qc_checks"."applies_to_kind" in ('asset_version', 'generation', 'production', 'publication')),
	CONSTRAINT "qc_checks_check_type_check" CHECK ("qc_checks"."check_type" in ('technical', 'moderation', 'rights', 'editorial')),
	CONSTRAINT "qc_checks_status_check" CHECK ("qc_checks"."status" in ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "qc_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "qc_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"severity" text NOT NULL,
	"description" text NOT NULL,
	"resolution" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qc_issues_severity_check" CHECK ("qc_issues"."severity" in ('blocker', 'major', 'minor', 'note')),
	CONSTRAINT "qc_issues_resolution_check" CHECK ("qc_issues"."resolution" in ('open', 'resolved', 'waived'))
);
--> statement-breakpoint
ALTER TABLE "qc_issues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "qc_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"check_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"evaluated_by" text NOT NULL,
	"rule_ref" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qc_results_outcome_check" CHECK ("qc_results"."outcome" in ('pass', 'fail', 'warn', 'skipped')),
	CONSTRAINT "qc_results_evaluated_by_check" CHECK ("qc_results"."evaluated_by" in ('human', 'automated'))
);
--> statement-breakpoint
ALTER TABLE "qc_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "qc_review_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reviewer_operator_id" uuid NOT NULL,
	"reason" text,
	"capability_used" text DEFAULT 'production.approve' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qc_review_decisions_decision_check" CHECK ("qc_review_decisions"."decision" in ('approve', 'reject', 'changes_requested'))
);
--> statement-breakpoint
ALTER TABLE "qc_review_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "qc_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_ref" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qc_reviews_org_subject_unique" UNIQUE("org_id","subject_kind","subject_ref"),
	CONSTRAINT "qc_reviews_subject_kind_check" CHECK ("qc_reviews"."subject_kind" in ('asset_version', 'generation', 'production', 'publication')),
	CONSTRAINT "qc_reviews_status_check" CHECK ("qc_reviews"."status" in ('pending', 'in_review', 'approved', 'rejected', 'changes_requested'))
);
--> statement-breakpoint
ALTER TABLE "qc_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "qc_checks" ADD CONSTRAINT "qc_checks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_issues" ADD CONSTRAINT "qc_issues_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_issues" ADD CONSTRAINT "qc_issues_result_id_qc_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."qc_results"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_results" ADD CONSTRAINT "qc_results_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_results" ADD CONSTRAINT "qc_results_review_id_qc_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."qc_reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_results" ADD CONSTRAINT "qc_results_check_id_qc_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."qc_checks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_review_decisions" ADD CONSTRAINT "qc_review_decisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_review_decisions" ADD CONSTRAINT "qc_review_decisions_review_id_qc_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."qc_reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_reviews" ADD CONSTRAINT "qc_reviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_qc_checks_org_applies" ON "qc_checks" USING btree ("org_id","applies_to_kind");--> statement-breakpoint
CREATE INDEX "idx_qc_issues_org_result" ON "qc_issues" USING btree ("org_id","result_id");--> statement-breakpoint
CREATE INDEX "idx_qc_issues_org_resolution" ON "qc_issues" USING btree ("org_id","resolution");--> statement-breakpoint
CREATE INDEX "idx_qc_results_org_review" ON "qc_results" USING btree ("org_id","review_id");--> statement-breakpoint
CREATE INDEX "idx_qc_results_review_check" ON "qc_results" USING btree ("review_id","check_id");--> statement-breakpoint
CREATE INDEX "idx_qc_review_decisions_org_review" ON "qc_review_decisions" USING btree ("org_id","review_id");--> statement-breakpoint
CREATE INDEX "idx_qc_reviews_org_status" ON "qc_reviews" USING btree ("org_id","status");