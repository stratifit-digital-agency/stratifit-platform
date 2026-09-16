/**
 * Branded entity ID types.
 *
 * Every important entity is traceable by an ID (organization, project,
 * production, scene, shot, generation, asset, job, publication, conversation).
 * Branded string types prevent mixing IDs of different entity kinds while
 * remaining plain strings on the wire.
 */
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type OrganizationId = Brand<string, "OrganizationId">;
export type ProjectId = Brand<string, "ProjectId">;
export type ProductionId = Brand<string, "ProductionId">;
export type SceneId = Brand<string, "SceneId">;
export type ShotId = Brand<string, "ShotId">;
export type GenerationId = Brand<string, "GenerationId">;
export type AssetId = Brand<string, "AssetId">;
export type JobId = Brand<string, "JobId">;
export type PublicationId = Brand<string, "PublicationId">;
export type ConversationId = Brand<string, "ConversationId">;
export type ModelId = Brand<string, "ModelId">;
export type WorkflowId = Brand<string, "WorkflowId">;

export const asOrganizationId = (v: string) => v as OrganizationId;
export const asProjectId = (v: string) => v as ProjectId;
export const asProductionId = (v: string) => v as ProductionId;
export const asSceneId = (v: string) => v as SceneId;
export const asShotId = (v: string) => v as ShotId;
export const asGenerationId = (v: string) => v as GenerationId;
export const asAssetId = (v: string) => v as AssetId;
export const asJobId = (v: string) => v as JobId;
export const asPublicationId = (v: string) => v as PublicationId;
export const asConversationId = (v: string) => v as ConversationId;
export const asModelId = (v: string) => v as ModelId;
export const asWorkflowId = (v: string) => v as WorkflowId;
