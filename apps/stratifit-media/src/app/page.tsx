import { publicationReader } from "@/lib/publications";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const published = await publicationReader.listPublished("stratifit-media");

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-3xl font-bold">Home</h1>
      <p className="mt-2 text-gray-600">
        Films, series, shorts, music, and live programs from Stratifit creators.
      </p>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">Latest publications</h2>
        {published.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed border-gray-300 p-8 text-center text-gray-500">
            Nothing published yet — content appears here once approved in Stratifit
            Control.
          </div>
        ) : (
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {published.map((p) => (
              <li key={p.publicationId} className="rounded-lg border border-gray-200 p-5">
                <h3 className="font-semibold">{p.title}</h3>
                <p className="mt-1 text-sm text-gray-500">{p.contentType}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
