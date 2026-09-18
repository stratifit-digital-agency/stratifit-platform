CREATE TABLE "compute_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"gpu_class" text NOT NULL,
	"vram_gb" integer NOT NULL,
	"workers" integer NOT NULL,
	"concurrency" integer NOT NULL,
	"estimated_runtime_seconds" integer NOT NULL,
	"storage_mb" integer NOT NULL,
	"estimated_cost_usd" numeric(12, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compute_requirements_positive_check" CHECK ("compute_requirements"."vram_gb" >= 0 and "compute_requirements"."workers" > 0 and "compute_requirements"."concurrency" > 0 and "compute_requirements"."estimated_runtime_seconds" >= 0 and "compute_requirements"."storage_mb" >= 0)
);
--> statement-breakpoint
ALTER TABLE "compute_requirements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "compute_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"allocation_ref" text NOT NULL,
	"actual_runtime_seconds" integer NOT NULL,
	"actual_cost_usd" numeric(12, 4) NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compute_usage_positive_check" CHECK ("compute_usage"."actual_runtime_seconds" >= 0 and "compute_usage"."actual_cost_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "compute_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"worker_ref" text NOT NULL,
	"allocation_ref" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"outcome" text,
	"error_detail" text,
	"progress_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage_record_id" uuid,
	CONSTRAINT "job_attempts_job_attempt_unique" UNIQUE("job_id","attempt_number"),
	CONSTRAINT "job_attempts_outcome_check" CHECK ("job_attempts"."outcome" is null or "job_attempts"."outcome" in ('succeeded', 'failed', 'timed_out', 'cancelled')),
	CONSTRAINT "job_attempts_attempt_number_check" CHECK ("job_attempts"."attempt_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "job_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "job_dependencies" (
	"job_id" uuid NOT NULL,
	"depends_on_job_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_dependencies_pk" PRIMARY KEY("job_id","depends_on_job_id"),
	CONSTRAINT "job_dependencies_no_self_check" CHECK ("job_dependencies"."job_id" <> "job_dependencies"."depends_on_job_id")
);
--> statement-breakpoint
ALTER TABLE "job_dependencies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"job_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"manifest_ref" uuid,
	"compute_requirement_id" uuid,
	"status" text DEFAULT 'created' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"cancellation_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_org_type_key_unique" UNIQUE("org_id","job_type","idempotency_key"),
	CONSTRAINT "jobs_type_check" CHECK ("jobs"."job_type" in ('generation.execute', 'media.process', 'publication.deliver', 'notification.send', 'qc.run')),
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('created', 'queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "jobs_max_attempts_check" CHECK ("jobs"."max_attempts" > 0),
	CONSTRAINT "jobs_progress_check" CHECK ("jobs"."progress" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "compute_requirements" ADD CONSTRAINT "compute_requirements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_usage" ADD CONSTRAINT "compute_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_dependencies" ADD CONSTRAINT "job_dependencies_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_dependencies" ADD CONSTRAINT "job_dependencies_depends_on_job_id_jobs_id_fk" FOREIGN KEY ("depends_on_job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_dependencies" ADD CONSTRAINT "job_dependencies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_compute_requirements_org" ON "compute_requirements" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_compute_usage_org" ON "compute_usage" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_job_attempts_job" ON "job_attempts" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "idx_job_dependencies_depends_on" ON "job_dependencies" USING btree ("depends_on_job_id");--> statement-breakpoint
CREATE INDEX "idx_jobs_org_status" ON "jobs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_jobs_org_subject" ON "jobs" USING btree ("org_id","subject_kind","subject_id");