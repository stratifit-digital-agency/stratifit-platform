import { headers } from "next/headers";
import { resolveMediaIdentity } from "@/lib/identity";
import { getProgress, toProgressView } from "@/lib/progress";
import { publicContentReader } from "@/lib/content";

export const dynamic = "force-dynamic";

/**
 * Continue Watching (Stage 2.14, D2.14-4 minimal surface).
 *
 * Rendered ONLY for authenticated audience users; anonymous visitors see
 * nothing. Data path: progress rows (audience-private, owner-scoped) joined
 * to the public-content projection for title/duration. Percentage is shown
 * only where the content row carries a duration. The contentRef is the
 * opaque public content id; no internal production/publication/asset/
 * generation/QC identifier ever reaches this markup, and no content-detail
 * routes are invented (Media has none yet).
 */
export default async function HomePage() {
  const published = await publicContentReader.listContent();
  // Server-component identity resolution: the session reference comes from
  // the request cookies/headers via next/headers — never from client state.
  const identity = await resolveMediaIdentity(
    new Request("http://local/media-home", { headers: await headers() }),
  );

  const progressItems = identity
    ? (await getProgress(identity.userId, 12))
        .map(toProgressView)
        .map((p) => {
          const content = published.find((c) => c.contentRef === p.contentRef);
          return {
            ...p,
            title: content?.title ?? "Unavailable content",
            percent:
              content?.durationSeconds && content.durationSeconds > 0
                ? Math.min(100, Math.round((p.positionSeconds / content.durationSeconds) * 100))
                : null,
          };
        })
    : [];

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-3xl font-bold">Home</h1>
      <p className="mt-2 text-gray-600">
        Films, series, shorts, music, and live programs from Stratifit creators.
      </p>

      {progressItems.length > 0 ? (
        <section className="mt-8" data-testid="continue-watching">
          <h2 className="text-xl font-semibold">Continue watching</h2>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {progressItems.map((p) => (
              <li key={p.contentRef} className="rounded-lg border border-gray-200 p-5">
                <h3 className="font-semibold">{p.title}</h3>
                <p className="mt-1 text-sm text-gray-500">
                  {Math.floor(p.positionSeconds / 60)}m {p.positionSeconds % 60}s watched
                  {p.percent !== null ? ` · ${p.percent}%` : ""}
                </p>
                <div className="mt-2 h-1.5 w-full rounded bg-gray-200">
                  {p.percent !== null ? (
                    <div className="h-1.5 rounded bg-gray-900" style={{ width: `${p.percent}%` }} />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="text-xl font-semibold">Latest publications</h2>
        {published.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed border-gray-300 p-8 text-center text-gray-500">
            Nothing published yet — content appears here once approved in Stratifit
            Control.
          </div>
        ) : (
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {published.map((c) => (
              <li key={c.contentRef} data-slug={c.slug} className="rounded-lg border border-gray-200 p-5">
                <h3 className="font-semibold">{c.title}</h3>
                <p className="mt-1 text-sm text-gray-500">{c.contentType}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
