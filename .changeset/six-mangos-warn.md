---
"@katajs-framework/core": patch
---

`kata init --with-docs-mcp`'s "next steps" output no longer tells you the
generated `@katajs-framework/docs-mcp` registration "requires it to be
published to npm first" — it has been published since `0.3.1`. The message
now correctly explains that the unpinned `npx` entry resolves the latest
published snapshot, and how to pin a version.
