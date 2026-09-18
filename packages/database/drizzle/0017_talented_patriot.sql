CREATE TABLE "generation_provenance" (
	"generation_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"output_storage_key" text,
	"output_checksum" text,
	"output_byte_size" bigint,
	"executed_seed" text,
	"worker_ref" text,
	"gpu_class" text,
	"runtime_version" text,
	"actual_cost_usd" numeric(12, 4),
	"actual_runtime_seconds" integer,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generation_provenance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"production_id" uuid,
	"scene_id" uuid,
	"shot_id" uuid,
	"job_id" uuid,
	"output_asset_version_id" uuid,
	"model_id" uuid NOT NULL,
	"model_version_id" uuid NOT NULL,
	"workflow_id" uuid,
	"workflow_version_id" uuid,
	"parent_generation_id" uuid,
	"input_asset_version_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt" text NOT NULL,
	"negative_prompt" text,
	"seed" text,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolution" text,
	"fps" integer,
	"duration_seconds" numeric(10, 3),
	"adapters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimated_cost_usd" numeric(12, 4),
	"request_key" text,
	"last_error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generations_org_request_key_unique" UNIQUE("org_id","request_key"),
	CONSTRAINT "generations_status_check" CHECK ("generations"."status" in ('requested', 'running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "generations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "generation_provenance" ADD CONSTRAINT "generation_provenance_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_provenance" ADD CONSTRAINT "generation_provenance_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_parent_generation_id_generations_id_fk" FOREIGN KEY ("parent_generation_id") REFERENCES "public"."generations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_generation_provenance_org" ON "generation_provenance" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_generations_org_status" ON "generations" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_generations_org_production" ON "generations" USING btree ("org_id","production_id");