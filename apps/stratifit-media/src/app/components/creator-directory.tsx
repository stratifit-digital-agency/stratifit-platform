import { listCreators } from "@/lib/creators";

/**
 * Creator Directory (Stage 2.16, D2.16-8 minimal surface).
 *
 * A data-bound list of ACTIVE creator profiles rendered on the public home
 * page. Every field comes from the People public projection whitelist
 * (handle/displayName/bio/interests plus OPAQUE avatarRef/posterRef
 * references — never resolved to storage URLs in Media). No creator signup,
 * no editing, no counters, no recommendations, no follow actions here (the
 * creator follow action targets an ACTIVE profile by ref through the
 * existing social API surface).
 */
export async function CreatorDirectory({ limit = 12 }: { limit?: number }) {
  const creators = await listCreators(limit);
  if (creators.length === 0) {
    return null; // No active creators yet — render nothing (no empty-state chrome).
  }
  return (
    <section aria-label="Creators" className="creators">
      <h2>Creators</h2>
      <ul>
        {creators.map((c) => (
          <li key={c.handle}>
            <article data-creator-handle={c.handle}>
              <h3>{c.displayName}</h3>
              {c.bio ? <p>{c.bio}</p> : null}
              {c.interests.length > 0 ? (
                <p className="interests">{c.interests.join(" · ")}</p>
              ) : null}
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}
