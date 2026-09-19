ALTER TABLE "distribution_references" DROP CONSTRAINT "distribution_references_status_check";--> statement-breakpoint
ALTER TABLE "publication_versions" DROP CONSTRAINT "publication_versions_platform_target_check";--> statement-breakpoint
ALTER TABLE "distribution_references" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "publication_versions" DROP COLUMN "qc_review_id";--> statement-breakpoint
ALTER TABLE "publication_versions" DROP COLUMN "subject_snapshot";--> statement-breakpoint
ALTER TABLE "publication_versions" DROP COLUMN "platform_target";