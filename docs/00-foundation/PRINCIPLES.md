# Principles

> **Bootstrap draft derived from operator architecture brief — pending human review**

1. **Two applications, one platform core.** Stratifit Control and Stratifit Media are
   separate applications over shared packages. The public platform must never touch
   internal AI production infrastructure.
2. **Content origin rule.** Everything public on Stratifit Media originates from the
   internal Control/production ecosystem, flowing through planning, production, QC,
   approval, and publication.
3. **Public users are audience.** They watch; they do not produce. No generation, no
   uploads, no studio, no internal APIs.
4. **AI is governed.** AI may plan, suggest, prompt, analyze, and assist — always
   producing schema-validated output. Deterministic backend services enforce
   authorization and execution. AI never holds credentials, never bypasses gates,
   never spends unbounded budget, never alters immutable provenance.
5. **The Production Gate comes first.** No expensive GPU allocation before planning,
   validation, and required human approval. The approved manifest is the executable
   contract from planning to execution.
6. **Models are pluggable.** Capability contracts + adapters; a new model never
   requires rewriting the production engine. Model versions remain identifiable and
   reproducible.
7. **Workflows are pluggable.** Workflow contract → registry → runtime;
   ComfyUI is one runtime behind the abstraction, never a platform dependency.
8. **Compute is abstracted.** RunPod is a provider behind ComputeProvider, not the
   platform's architecture. Estimates are recorded against actuals to improve planning.
9. **Publishing is separate from production.** Publication records flow through
   publishing adapters; no platform-specific logic inside the production domain.
10. **Metadata in PostgreSQL, binaries in object storage.** Structured data and
    relationships in the database; large media never in the database.
11. **Provenance everywhere.** Generations, assets, and publications carry full
    provenance; historical versions stay addressable and reproducible across model
    upgrades.
12. **Events communicate state; transactions own it.** Domain events are idempotent and
    never replace transactional domain state.
13. **Fail safely.** A failed generation never destroys a production; a failed adapter
    never invalidates a master; jobs support retry, cancellation, and idempotency.
14. **Never trust the browser.** All authorization is server-side, least-privilege,
    with audit logs, signed media access where required, and rate limiting.
15. **Modular, not micro.** Start with clean in-process module boundaries; extract
    deployable services only for real operational reasons.
16. **Humans retain critical authority.** Approval gates, publication, and identity
    control remain human decisions.
