CREATE TABLE "gate_decision_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"production_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"inputs_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evaluated_by" uuid NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_decision_records_decision_check" CHECK ("gate_decision_records"."decision" in ('pass', 'fail'))
);
--> statement-breakpoint
ALTER TABLE "gate_decision_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "manifest_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"production_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"manifest_document" jsonb NOT NULL,
	"issued_by" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manifest_versions_production_version_unique" UNIQUE("production_id","version_number"),
	CONSTRAINT "manifest_versions_version_number_check" CHECK ("manifest_versions"."version_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "manifest_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "production_plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"production_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"plan_document" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_plan_versions_production_version_unique" UNIQUE("production_id","version_number"),
	CONSTRAINT "production_plan_versions_version_number_check" CHECK ("production_plan_versions"."version_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "production_plan_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "productions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"current_plan_version_id" uuid,
	"current_manifest_version_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "productions_status_check" CHECK ("productions"."status" in (
        'draft', 'planning', 'in_gate', 'approved', 'queued', 'in_production',
        'post_production', 'qc', 'ready_for_publication', 'published', 'archived',
        'on_hold', 'changes_requested', 'cancelled'
      ))
);
--> statement-breakpoint
ALTER TABLE "productions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_org_slug_unique" UNIQUE("org_id","slug"),
	CONSTRAINT "projects_status_check" CHECK ("projects"."status" in ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gate_decision_records" ADD CONSTRAINT "gate_decision_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decision_records" ADD CONSTRAINT "gate_decision_records_production_id_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decision_records" ADD CONSTRAINT "gate_decision_records_plan_version_id_production_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."production_plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decision_records" ADD CONSTRAINT "gate_decision_records_evaluated_by_operators_id_fk" FOREIGN KEY ("evaluated_by") REFERENCES "public"."operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_versions" ADD CONSTRAINT "manifest_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_versions" ADD CONSTRAINT "manifest_versions_production_id_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_versions" ADD CONSTRAINT "manifest_versions_plan_version_id_production_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."production_plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manifest_versions" ADD CONSTRAINT "manifest_versions_issued_by_operators_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_plan_versions" ADD CONSTRAINT "production_plan_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_plan_versions" ADD CONSTRAINT "production_plan_versions_production_id_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_plan_versions" ADD CONSTRAINT "production_plan_versions_created_by_operators_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "productions" ADD CONSTRAINT "productions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "productions" ADD CONSTRAINT "productions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_operators_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_gate_decision_records_production" ON "gate_decision_records" USING btree ("production_id");--> statement-breakpoint
CREATE INDEX "idx_gate_decision_records_plan_version" ON "gate_decision_records" USING btree ("plan_version_id");--> statement-breakpoint
CREATE INDEX "idx_manifest_versions_production" ON "manifest_versions" USING btree ("production_id");--> statement-breakpoint
CREATE INDEX "idx_production_plan_versions_production" ON "production_plan_versions" USING btree ("production_id");--> statement-breakpoint
CREATE INDEX "idx_productions_org" ON "productions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_productions_project" ON "productions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_projects_org" ON "projects" USING btree ("org_id");