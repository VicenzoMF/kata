#!/usr/bin/env bash
# extract-write-paths.sh — given a Bash command string, emit one
# write-target path per line. Used by the Codex Pre/PostToolUse hooks
# to translate Codex's Bash-only matcher into a per-file event the
# Claude hooks can consume.
#
# Heuristic, not a shell parser. Catches the cheap paths an agent
# reaches for (tee, sed -i, cp/mv/touch, redirects, heredocs around
# any of those). Does NOT try to peek inside quoted strings or
# sub-interpreters (`python -c "open(...)"`) — those are out of scope
# and documented in design.md as acceptable false negatives.
#
# Usage:
#   extract-write-paths.sh "<command>"            # arg form
#   echo "<command>" | extract-write-paths.sh     # stdin form
#
# Exit: always 0. Empty output means "no detectable writes".

set -uo pipefail

cmd="${1:-$(cat)}"

# Strip backslash-newline line continuations so they don't break
# segment splitting.
cmd="${cmd//$'\\\n'/ }"

emit() {
  # Skip /dev/null and process substitutions — never harness-relevant.
  case "$1" in
    /dev/null|/dev/stdout|/dev/stderr|"<("*|">("*) return ;;
    "") return ;;
  esac
  printf '%s\n' "$1"
}

# Split on shell segment separators that introduce a new command.
# We intentionally do not split inside quotes — a quoted `;` is rare
# in agent-generated commands and not worth a real parser.
IFS=$'\n' read -rd '' -a segments <<<"$(printf '%s' "$cmd" |
  awk '{
    n = split($0, parts, /(\|\||&&|;|\|)/);
    for (i = 1; i <= n; i++) print parts[i];
  }')" || true

for seg in "${segments[@]}"; do
  # Trim leading/trailing whitespace.
  seg="${seg#"${seg%%[![:space:]]*}"}"
  seg="${seg%"${seg##*[![:space:]]}"}"
  [ -z "$seg" ] && continue

  # 1. Redirects: `> file`, `>> file`, `>| file`, `&> file`, `2> file`,
  #    `&>> file`. The path follows the operator, optionally with
  #    whitespace. Greedy enough for command-end redirects.
  while [[ "$seg" =~ (^|[[:space:]])(\&?\>{1,2}\|?|[0-9]+\>)[[:space:]]*([^[:space:]\|;\&]+) ]]; do
    emit "${BASH_REMATCH[3]}"
    # Strip the matched chunk so we can find further redirects.
    seg="${seg//"${BASH_REMATCH[0]}"/ }"
  done

  # 2. tee [-a|--append|-i] file...
  if [[ "$seg" =~ (^|[[:space:]])tee([[:space:]]+-[aAi]+| --append| --ignore-interrupts)*([[:space:]]+([^[:space:]\|;\&]+)) ]]; then
    emit "${BASH_REMATCH[4]}"
  fi

  # 3. sed -i [...] file
  if [[ "$seg" =~ (^|[[:space:]])sed[[:space:]]+(.*[[:space:]])?-i([[:space:]]|=) ]]; then
    # Last whitespace-separated token after stripping -e/-E/-i flags is
    # the file. Naive but sufficient.
    last="$(printf '%s' "$seg" |
      awk '{ for (i = NF; i >= 1; i--) if ($i !~ /^-/ && $i != "sed") { print $i; exit } }')"
    emit "$last"
  fi

  # 4. cp [flags] src dst  /  cp [flags] src... dstdir
  #    mv [flags] src dst
  for tool in cp mv; do
    if [[ "$seg" =~ (^|[[:space:]])$tool([[:space:]]|$) ]]; then
      last="$(printf '%s' "$seg" |
        awk -v t="$tool" '{ for (i = NF; i >= 1; i--) if ($i !~ /^-/ && $i != t) { print $i; exit } }')"
      emit "$last"
    fi
  done

  # 5. touch file...
  if [[ "$seg" =~ (^|[[:space:]])touch([[:space:]]+) ]]; then
    # All non-flag positionals after `touch`.
    printf '%s' "$seg" |
      awk '{
        seen = 0;
        for (i = 1; i <= NF; i++) {
          if (!seen) { if ($i == "touch") seen = 1; continue }
          if ($i ~ /^-/) continue;
          print $i;
        }
      }' | while read -r p; do emit "$p"; done
  fi
done | awk 'NF && !seen[$0]++'
