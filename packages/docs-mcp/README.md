# @kata/docs-mcp

A local [MCP](https://modelcontextprotocol.io) server that lets an AI agent
search Kata's documentation instead of guessing at APIs it was never trained
on ([ADR-0022](../../docs/adr/0022-docs-mcp-lexical-search-over-vector-rag.md)).
It indexes `docs/guide`, `docs/cookbook`, `docs/reference`, and `docs/adr`
in memory on boot — lexical full-text search, not embeddings — and exposes
three tools over stdio.

## Usage

```sh
pnpm --filter=@kata/docs-mcp start   # stdio MCP server (tsx, no build step)
```

Register it with an MCP client (e.g. Claude Code) pointing at that command;
the server resolves `docs/` relative to its own location in the monorepo, so
it works regardless of the client's working directory.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `search_docs` | `query`, optional `section` (`guide`\|`cookbook`\|`reference`\|`adr`), `limit` | ranked hits: `{ path, title, heading, snippet, score }` |
| `get_toc` | — | every indexed doc grouped by section, with title/description/headings |
| `read_doc` | `path`, optional `heading` | the full file body, or just one heading's section |

`get_toc` exists so an agent that already knows roughly where to look can
navigate directly, without a search round-trip.

## Why lexical search, not RAG

The corpus is small (~80 files, ~19k lines) and the dominant query shape is
exact API/type names, not paraphrased concepts — lexical match wins on both
precision and simplicity. See ADR-0022 for the full rationale and the
rejected alternatives (embeddings, dumping all docs as static context).

Because the corpus is this small, the index is rebuilt from scratch on every
server boot — no persisted index, no cache-invalidation pipeline to keep in
sync with `docs/` edits.
