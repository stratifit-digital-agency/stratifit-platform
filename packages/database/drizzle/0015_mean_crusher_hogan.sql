CREATE TABLE "model_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"version" text NOT NULL,
	"adapter_ref" text NOT NULL,
	"compatibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_versions_org_model_version_unique" UNIQUE("org_id","model_id","version"),
	CONSTRAINT "model_versions_status_check" CHECK ("model_versions"."status" in ('active', 'deprecated', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "model_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"capability_kind" text NOT NULL,
	"display_name" text NOT NULL,
	"vendor_label" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "models_org_name_unique" UNIQUE("org_id","name"),
	CONSTRAINT "models_capability_kind_check" CHECK ("models"."capability_kind" in ('image.generation', 'video.generation', 'voice.synthesis', 'music.generation', 'audio', 'lip.sync', 'sfx', 'vfx', 'enhancement')),
	CONSTRAINT "models_status_check" CHECK ("models"."status" in ('active', 'deprecated', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "models" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" text NOT NULL,
	"runtime_ref" text NOT NULL,
	"definition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"compatibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_versions_org_workflow_version_unique" UNIQUE("org_id","workflow_id","version"),
	CONSTRAINT "workflow_versions_status_check" CHECK ("workflow_versions"."status" in ('active', 'deprecated', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "workflow_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"supports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_org_name_unique" UNIQUE("org_id","name"),
	CONSTRAINT "workflows_status_check" CHECK ("workflows"."status" in ('active', 'deprecated', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "workflows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_versions" ADD CONSTRAINT "model_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_versions" ADD CONSTRAINT "model_versions_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_model_versions_model" ON "model_versions" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "idx_models_org_status" ON "models" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_models_org_capability" ON "models" USING btree ("org_id","capability_kind");--> statement-breakpoint
CREATE INDEX "idx_workflow_versions_workflow" ON "workflow_versions" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_workflows_org_status" ON "workflows" USING btree ("org_id","status");