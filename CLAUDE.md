# Kata — Claude Code Instructions

See @AGENTS.md for the canonical instructions (shared with Codex and other agents).

Claude-specific notes:
- `.claude/settings.json` defines PostToolUse / PreToolUse / Stop hooks once
  the verifier exists (currently no-op).
- Use `kata verify --json` in PostToolUse to inject feedback as
  `hookSpecificOutput.additionalContext`.
