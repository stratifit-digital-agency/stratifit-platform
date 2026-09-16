import { z } from "zod";

/**
 * AI capability contracts.
 *
 * The Production Engine is never hardcoded to a specific AI model. Models are
 * selected through capability contracts; adapters translate a contract into a
 * specific model's API/runtime. Model versions remain identifiable so
 * generations stay reproducible.
 */

export const ImageGenerationCapability = z.object({
  kind: z.literal("image.generation"),
  resolution: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  seed: z.number().int().optional(),
});

export const VideoGenerationCapability = z.object({
  kind: z.literal("video.generation"),
  resolution: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  fps: z.number().int().positive(),
  durationSeconds: z.number().positive(),
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  seed: z.number().int().optional(),
});

export const VoiceCapability = z.object({
  kind: z.literal("voice.synthesis"),
  text: z.string().min(1),
  language: z.string().min(2).max(12),
  seed: z.number().int().optional(),
});

export const MusicCapability = z.object({
  kind: z.literal("music.generation"),
  durationSeconds: z.number().positive(),
  prompt: z.string().min(1),
  seed: z.number().int().optional(),
});

/** Discriminated union of all capability contracts. */
export const CapabilityRequest = z.discriminatedUnion("kind", [
  ImageGenerationCapability,
  VideoGenerationCapability,
  VoiceCapability,
  MusicCapability,
]);

export type CapabilityRequest = z.infer<typeof CapabilityRequest>;
export type CapabilityKind = CapabilityRequest["kind"];

/** Capability kinds the model registry understands (extensible). */
export const CAPABILITY_KINDS = [
  "image.generation",
  "video.generation",
  "voice.synthesis",
  "music.generation",
  // categories reserved for growth; adapters add them when models exist
  "audio",
  "lip.sync",
  "sfx",
  "vfx",
  "enhancement",
] as const satisfies readonly CapabilityKind[] | readonly string[];
