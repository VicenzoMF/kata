#!/usr/bin/env bash
# Tests for extract-write-paths.sh. Plain shell — runs in any kata
# checkout without pnpm. Wired into `pnpm test:hooks` via root
# package.json.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EXTRACT="$HERE/extract-write-paths.sh"

fails=0
ran=0

check() {
  local name="$1" cmd="$2" expected="$3"
  ran=$((ran + 1))
  local actual
  actual="$("$EXTRACT" "$cmd")"
  if [ "$actual" = "$expected" ]; then
    printf 'OK   %s\n' "$name"
  else
    fails=$((fails + 1))
    printf 'FAIL %s\n  cmd:      %s\n  expected: %q\n  actual:   %q\n' \
      "$name" "$cmd" "$expected" "$actual"
  fi
}

check 'redirect >'                'echo foo > a.ts'             'a.ts'
check 'redirect >>'               'echo hello >> /tmp/x'        '/tmp/x'
check 'tee'                       'echo x | tee b.json'         'b.json'
check 'tee -a'                    'echo x | tee -a b.json'      'b.json'
check 'sed -i short'              'sed -i s/x/y/ c.ts'          'c.ts'
check 'sed -i with -e'            'sed -i -e s/a/b/ d.ts'       'd.ts'
check 'cp two-arg'                'cp src.ts dst.ts'            'dst.ts'
check 'mv two-arg'                'mv old new'                  'new'
check 'touch one file'            'touch a.ts'                  'a.ts'
check 'touch two files'           'touch a.ts b.ts'             $'a.ts\nb.ts'
check 'cat is read-only'          'cat a.ts'                    ''
check 'rm is not a write target'  'rm a.ts'                     ''
check 'segmented &&'              'pnpm test && echo done > log.txt' 'log.txt'
check 'heredoc with redirect'     $'cat <<EOF > .codex/hooks.json\n{}\nEOF' '.codex/hooks.json'
check 'multiple writes in chain'  'sed -i s/x/y/ c.ts && cp d.ts e.ts' $'c.ts\ne.ts'
check 'redirect to /dev/null'     'pnpm test > /dev/null'       ''
check 'stderr redirect 2>'        'pnpm build 2> errs.log'      'errs.log'
check 'append &>>'                'pnpm dev &>> serve.log'      'serve.log'
check 'benign command'            'pnpm typecheck'              ''

printf '\n%d run, %d failed.\n' "$ran" "$fails"
exit "$fails"
