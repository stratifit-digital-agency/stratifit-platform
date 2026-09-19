"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { resolveMediaIdentity } from "@/lib/identity";
import { comment, follow, like, principalOf, save, share, unfollow, unlike, unsave } from "@/lib/social";

/**
 * Server actions backing the minimal Stage 2.15 social affordances
 * (D2.15 scope: no UI beyond data-bound toggles/lists). Identity is always
 * re-resolved server-side inside the action — a client can only trigger the
 * action, never supply the principal.
 */
const principal = async () => {
  const identity = await resolveMediaIdentity(
    new Request("http://local/media-action", { headers: await headers() }),
  );
  return identity ? principalOf(identity) : null;
};

const uuidOrThrow = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("contentRef required");
  return value;
};

export async function toggleLikeAction(contentRef: string): Promise<{ liked: boolean }> {
  const p = await principal();
  if (!p) throw new Error("unauthenticated");
  const ref = uuidOrThrow(contentRef);
  const result = await like(p, ref);
  if (!result.ok) throw new Error(result.reason);
  const liked = result.state === "liked";
  revalidatePath("/");
  return { liked };
}

export async function toggleSaveAction(contentRef: string): Promise<{ saved: boolean }> {
  const p = await principal();
  if (!p) throw new Error("unauthenticated");
  const ref = uuidOrThrow(contentRef);
  const result = await save(p, ref);
  if (!result.ok) throw new Error(result.reason);
  const saved = result.state === "saved";
  revalidatePath("/");
  return { saved };
}

export async function followAction(followeeRef: string): Promise<{ following: boolean }> {
  const p = await principal();
  if (!p) throw new Error("unauthenticated");
  const ref = uuidOrThrow(followeeRef);
  const result = await follow(p, ref);
  if (!result.ok) throw new Error(result.reason);
  revalidatePath("/");
  return { following: result.state === "following" };
}

export async function unfollowAction(followeeRef: string): Promise<{ following: boolean }> {
  const p = await principal();
  if (!p) throw new Error("unauthenticated");
  const ref = uuidOrThrow(followeeRef);
  const result = await unfollow(p, ref);
  if (!result.ok) throw new Error(result.reason);
  revalidatePath("/");
  return { following: false };
}

export async function commentAction(contentRef: string, body: string): Promise<{ commentId: string }> {
  const p = await principal();
  if (!p) throw new Error("unauthenticated");
  const ref = uuidOrThrow(contentRef);
  const result = await comment(p, { contentRef: ref, body });
  if (!result.ok) throw new Error(result.reason);
  revalidatePath("/");
  return { commentId: result.id };
}

export async function shareAction(contentRef: string, channel: "copy_link" | "external"): Promise<{ shareId: string }> {
  const p = await principal();
  if (!p) throw new Error("unauthenticated");
  const ref = uuidOrThrow(contentRef);
  const result = await share(p, { contentRef: ref, channel });
  if (!result.ok) throw new Error(result.reason);
  return { shareId: result.id };
}
