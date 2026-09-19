"use client";

import { useState, useTransition } from "react";
import { toggleLikeAction, toggleSaveAction } from "@/app/actions/social";

/**
 * Minimal data-bound like/save toggles (Stage 2.15, D2.15 scope: no Media
 * redesign — small inline buttons on the published-content cards). The
 * server action re-resolves identity server-side; this component only
 * triggers it.
 */
export function SocialActions({
  contentRef,
  initiallyLiked,
  initiallySaved,
}: {
  contentRef: string;
  initiallyLiked: boolean;
  initiallySaved: boolean;
}) {
  const [liked, setLiked] = useState(initiallyLiked);
  const [saved, setSaved] = useState(initiallySaved);
  const [pending, startTransition] = useTransition();

  return (
    <span className="mt-2 flex gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await toggleLikeAction(contentRef);
            setLiked(r.liked);
          })
        }
        className={`rounded border px-2 py-1 text-xs ${liked ? "border-pink-500 bg-pink-50 text-pink-700" : "border-gray-300 text-gray-600"}`}
        aria-pressed={liked}
      >
        {liked ? "Liked" : "Like"}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await toggleSaveAction(contentRef);
            setSaved(r.saved);
          })
        }
        className={`rounded border px-2 py-1 text-xs ${saved ? "border-amber-500 bg-amber-50 text-amber-700" : "border-gray-300 text-gray-600"}`}
        aria-pressed={saved}
      >
        {saved ? "Saved" : "Save"}
      </button>
    </span>
  );
}
