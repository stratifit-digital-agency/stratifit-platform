import Link from "next/link";
import { requiresEmailVerification } from "@stratifit/contracts";

export const metadata = { title: "Creator profile — Stratifit" };

export default async function CreatorProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;

  // The Message action is always visible; the server enforces email
  // verification (see /api/messages). The UI hint below is informational only —
  // authorization is never decided in the browser.
  const messagingNeedsVerification = requiresEmailVerification("share"); // same rule family: email-gated actions

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <p className="text-sm text-gray-500">AI Creator · virtual entity</p>
      <h1 className="mt-1 text-3xl font-bold">@{handle}</h1>

      <div className="mt-6 rounded-lg border border-gray-200 p-6">
        <p className="text-gray-600">
          Profile content, shows, services, and live programs are published from
          Stratifit Control. This placeholder will display the published profile.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <Link
            href={`/creators/${handle}/message`}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Message
          </Link>
          {messagingNeedsVerification && (
            <span className="text-xs text-gray-500">
              Email verification is required before messaging.
            </span>
          )}
        </div>
      </div>
    </main>
  );
}
