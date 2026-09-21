CREATE TABLE "rights_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"platforms" text[] NOT NULL,
	"territories" text[] NOT NULL,
	"enforcement" text NOT NULL,
	"reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rights_requirements_subject_scope_unique" UNIQUE("org_id","subject_kind","subject_id","scope"),
	CONSTRAINT "rights_requirements_subject_kind_check" CHECK ("rights_requirements"."subject_kind" in ('digital_human', 'character', 'persona', 'asset', 'production')),
	CONSTRAINT "rights_requirements_scope_check" CHECK ("rights_requirements"."scope" in ('generation', 'publication', 'advertising', 'messaging', 'derivative_creation')),
	CONSTRAINT "rights_requirements_enforcement_check" CHECK ("rights_requirements"."enforcement" in ('enforce', 'record_only')),
	CONSTRAINT "rights_requirements_platforms_check" CHECK ("rights_requirements"."platforms" <@ array['stratifit_media','youtube','tiktok','instagram','facebook','all']::text[] and array_length("rights_requirements"."platforms", 1) >= 1),
	CONSTRAINT "rights_requirements_reason_len_check" CHECK ("rights_requirements"."reason" is null or length("rights_requirements"."reason") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "rights_requirements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rights_requirements" ADD CONSTRAINT "rights_requirements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_rights_requirements_subject" ON "rights_requirements" USING btree ("org_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "idx_rights_requirements_org" ON "rights_requirements" USING btree ("org_id");