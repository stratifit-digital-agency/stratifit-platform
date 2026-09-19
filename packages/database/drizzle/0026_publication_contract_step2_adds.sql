ALTER TABLE "distribution_references" ADD COLUMN "delivery_outcome" text NOT NULL;--> statement-breakpoint
ALTER TABLE "publication_versions" ADD COLUMN "subject_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "publication_versions" ADD COLUMN "subject_ref" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "qc_review_id" uuid;--> statement-breakpoint
ALTER TABLE "distribution_references" ADD CONSTRAINT "distribution_references_delivery_outcome_check" CHECK ("distribution_references"."delivery_outcome" in ('delivered', 'failed'));--> statement-breakpoint
ALTER TABLE "publication_versions" ADD CONSTRAINT "publication_versions_subject_kind_check" CHECK ("publication_versions"."subject_kind" in ('production', 'asset_version', 'ai_creator_profile', 'campaign_creative'));