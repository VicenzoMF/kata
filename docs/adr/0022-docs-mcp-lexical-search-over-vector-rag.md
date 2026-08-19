# ADR-0022: Docs MCP server uses lexical/structural search, not vector RAG

- **Status:** Proposed
- **Date:** 2026-08-19
- **Deciders:** @VicenzoMF

## Context

Kata's core thesis is a framework meant to be developed *with* AI assistance
([[kata-framework]]). That thesis has a gap: adoption is still low, so no
mainstream model has Kata's APIs or conventions in its pretraining data — an
agent asked to write Kata code today has to guess or hallucinate.

`TODO-POC-SPEC.md` (this branch) formalizes exactly this test: a
framework-agnostic todo-list spec that an agent must implement using *only*
"uma ferramenta de busca dedicada às docs, ainda a ser construída." This ADR
decides what that tool is, starting with a local MCP server.

The docs corpus it needs to serve is `docs/` — 81 Markdown files, ~19k lines,
split across `guide/`, `cookbook/`, `adr/`, `reference/`, and a `pt/`
translation tree, built with VitePress. It is small, well-structured
(consistent headings, defined jargon per [[kata-docs-explanatory-voice]]),
and changes on every framework change — the index must stay cheap to rebuild.

## Decision

We will serve the docs to agents through an MCP server that indexes the raw
Markdown source with **lexical/full-text search plus structural navigation**,
not embedding-based vector RAG.

The server exposes three tools:

- `search_docs(query, limit?)` — ranked full-text (BM25-style) search over
  the indexed corpus, returning `{ path, heading, snippet }` per hit.
- `list_docs()` / `get_toc()` — a structural listing of sections and headings
  (guide/cookbook/adr/reference) so an agent can navigate directly when it
  already knows roughly where to look, without a search round-trip.
- `read_doc(path, section?)` — returns a full file or a single heading's
  section, verbatim.

The index is built from `docs/**/*.md` source (not the VitePress `dist/`
build), keyed by file path + heading path. No embedding model, no vector
store, and no chunking pipeline are introduced in this iteration.

## Alternatives considered

### A — Vector RAG (embeddings + vector DB, chunked docs)
Rejected for now. The corpus is small (~19k lines) — the retrieval problem
embeddings solve (surfacing relevant content across a large, loosely
structured corpus) doesn't exist yet at this size. Chunking risks splitting a
code example or type signature across chunk boundaries, which is exactly the
content an agent most needs intact. Lexical match is also normally *more*
precise than semantic similarity for exact API/type names (`defineRoute`,
`scoped<T>()`, ADR numbers) — the dominant query shape here. It also adds an
embedding-model dependency and a reindex pipeline that has to track every
`docs/` change, for no proven benefit yet.

### B — Dump all docs as static context / one big resource
Rejected. Even ~19k lines is wasteful to inject wholesale for a query that
touches one route convention; it doesn't scale as `reference/` and `pt/`
grow, and gives the agent no way to narrow scope on its own.

### C — Hybrid lexical + vector
Deferred, not rejected outright. Legitimate upgrade path if dogfooding via
`TODO-POC-SPEC.md` shows agents issuing paraphrased/conceptual queries that
lexical search misses, or if the corpus grows an order of magnitude. Not
justified today — revisit only if precision proves insufficient in practice.

## Consequences

### Positive
- Precise retrieval on the exact terms that matter most for correct Kata
  usage (API names, ADR numbers, file-naming conventions).
- No embedding model or vector DB to run locally — the server stays a thin,
  dependency-light process.
- Index rebuilds are cheap enough to run on every `docs/` change.
- Directly unblocks `TODO-POC-SPEC.md`, which names this tool as a
  precondition of the experiment.

### Negative / costs
- Weaker than semantic search on paraphrased or conceptual queries ("how do
  I stop leaking state between requests" instead of "scoped slot").
- Docs must keep the heading/terminology discipline already established by
  [[kata-docs-explanatory-voice]] — search quality degrades if that slips.
- Someone has to build and maintain the index + MCP server as a new,
  separate piece of tooling outside the app framework itself.

### Follow-ups
- Build the MCP server: `search_docs` / `list_docs`/`get_toc` / `read_doc`.
- Pick the FTS engine (e.g. SQLite FTS5, or an in-process JS lexical index)
  — not pinned by this ADR.
- Wire index rebuild into the existing docs build/verify pipeline.
- Wire this server into `TODO-POC-SPEC.md` as the tool under test.
- Revisit Alternative C if dogfooding surfaces precision gaps.

## Companion rules

None. This ADR governs external agent tooling, not application code inside
generated Kata projects — no `archgate` rule applies.

---
Numbering note: confirmed against `origin/main` on 2026-08-19 (after
`git fetch`; local `main` had been 18 commits stale). The old `0016-*`
six-way collision is resolved and merged — `0016` stays
hono-version-and-adapter-strategy, `0017`–`0021` are the other five in
their original alphabetical order. `0022` is the real next-free number as
of this writing. One contender remains: a still-unwritten ADR superseding
ADR-0015 D1 (`kata init` full-scaffold decision, PR #205/issue-200,
merged 2026-06-26 — the code shipped, the ADR never did). Whichever of the
two lands second takes `0023`. Reconfirm against `origin/main` at apply
time regardless — this note is a point-in-time check, not a lock.
