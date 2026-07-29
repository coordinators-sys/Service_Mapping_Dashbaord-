# ADR-001 — No bundler

**Status:** Accepted
**Date:** 2026-07-29
**Decided by:** Cluster Coordinator / Technical Lead
**Context:** Phases 4 and 5 of the July 2026 remediation brief

## Context

The repository has no build tooling: no `package.json`, no bundler, no
transpiler. `index.html` loads nine hand-ordered `<script>` tags.

Phases 4 and 5 asked for content-hashed filenames, immutable cache headers, a
performance budget enforced in CI, and a pre-rendered first paint. Every one of
those is conventionally delivered by introducing a bundler.

## Decision

**No bundler.** The outcomes are delivered without one:

| Outcome | Without a bundler |
|---|---|
| Content-hashed filenames | Small pre-deploy Python script that hashes the JS files, renames them and rewrites the `<script>` tags |
| Immutable caching | `max-age=31536000, immutable` on hashed assets; `index.html` stays `must-revalidate` |
| Offline / stale-while-revalidate | Service worker, tier-aware |
| Performance budget | Assertion in the CI job, not a bundler plugin |
| First paint | Hand-authored static Overview shell with skeleton tiles in `index.html`, hydrated when data lands |

## Rationale

The repository is currently editable by a non-developer. In a cluster context
where information-management staff rotate frequently and handover is often
thin, that may be the single most valuable property the codebase has: a
coordinator can open a file, change a label, and push.

A bundler converts that into a toolchain — install a runtime, install
dependencies, run a build, understand why the build failed. The cost is not the
bundler itself; it is that the next person to inherit this repository may not be
able to change anything at all.

The hashing script is the one piece that adds indirection, and it earns its
place by removing a worse thing: the manual `?v=NN` cache-bust that has to be
incremented by hand on every deploy. That is a standing human-error class —
eventually somebody forgets, and ships a stale-cache incident.

## Consequences

- No tree-shaking, no minification, no module system. The files are small and
  hand-ordered; this is accepted.
- Dependencies stay on CDN with SRI, rather than vendored and bundled.
- The hashing script becomes a required deploy step. If it is skipped, assets
  are served unhashed and the immutable headers must not be applied to them.
- CI is a guard rail (tests plus two assertions), not a build pipeline.

## Revisit if

A requirement genuinely cannot be met this way — not merely that it would be
more conventional with a bundler.
