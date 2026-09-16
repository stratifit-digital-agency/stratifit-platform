# Product Scope

> **Bootstrap draft derived from operator architecture brief — pending human review**

## In scope — Stratifit Control (internal)

AI Director, AI planning, projects, productions, production templates, production graph,
stories, scripts, worlds, characters, digital humans, personas, AI creators, voices,
wardrobe, locations, assets, generations, provenance, versioning, models, model registry,
model routing, workflow registry, workflow runtime, compute planning, GPU management,
RunPod operations, jobs, workers, media processing, editing, rendering, quality control,
live production, CMS, editorial, advertising, campaigns, publishing, audience management,
messaging, service leads, analytics, experimentation, platform administration,
permissions, audit.

## In scope — Stratifit Media (public)

Home, discover, films, movies, series, episodes, shorts, comedy, skits, music, music
videos, documentaries, live, creators, AI creators, published character profiles, search,
recommendations, trending, following, likes, comments, sharing, notifications, messaging,
contact.

## Explicitly out of scope for public users (audience)

AI generation of any kind (image/video/audio), AI character or AI creator creation,
workflow editing, ComfyUI access, RunPod access, GPU access, model registry access,
production worker access, internal production APIs, public creator studio, public
upload-to-publish flow.

## Out of scope for this foundation pass

Live Supabase authentication wiring, real AI generation, live RunPod calls, final domain
database schema (awaits DOMAIN_MODEL.md), BullMQ/Redis async infrastructure, third-party
publishing targets, observability SDKs.
