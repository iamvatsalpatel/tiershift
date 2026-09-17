#!/usr/bin/env bash
# Release audit for tiershift. Run from the repo root on the merged main branch.
# Every check prints PASS or FAIL. The script exits non-zero if any check fails.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fails=0
check() { if "$@" >/tmp/audit-step.log 2>&1; then echo "PASS  $*"; else echo "FAIL  $*"; sed 's/^/      /' /tmp/audit-step.log | head -15; fails=$((fails+1)); fi; }

echo "== 1. build, types, tests =="
check npm run typecheck
check npm test -- --run
check npm run build

echo "== 2. no test files or sources in the tarball; required files present =="
check bash -c 'npm pack --dry-run 2>&1 | grep -qE "npm notice [0-9.]+[kMB]+ +dist/index.js"'
check bash -c '! npm pack --dry-run 2>&1 | grep -qE "\.test\.|src/|bench/|\.env"'
check bash -c 'npm pack --dry-run 2>&1 | grep -q " tiershift.yaml" && npm pack --dry-run 2>&1 | grep -q " prices.yaml" && npm pack --dry-run 2>&1 | grep -q " LICENSE"'

echo "== 3. secrets: nothing that looks like a key in tracked files =="
# Test files hold deliberately fake keys (sk-test-..., sk-live-ABCDEFGH...) to prove redaction works; exclude them.
check bash -c '! git grep -nE "(sk-[A-Za-z0-9_-]{16,}|ts_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})" -- . ":!package-lock.json" ":!python/uv.lock" ":!*.test.ts" ":!python/tests/*"'
check bash -c '! git ls-files | grep -xq ".env"'
check bash -c 'git check-ignore -q .env && git check-ignore -q .tiershift/decisions.jsonl'

echo "== 4. clean-machine install of the packed tarball =="
check bash -c '
  set -e; T=$(mktemp -d); cd "$ROOT"; TB=$(npm pack --silent --pack-destination "$T" 2>/dev/null | tail -1)
  cd "$T"; npm init -y >/dev/null; npm install --silent "./$TB" >/dev/null
  [ -x node_modules/.bin/tiershift ]
  node_modules/.bin/tiershift 2>&1 | grep -q "tiershift"
  TYPESAFE_API_KEY=dummy node_modules/.bin/tiershift check 2>&1 | grep -q "local"
  node -e "import(\"tiershift\").then(m=>{ if(typeof m.createRouter!==\"function\") process.exit(1) })"
  rm -rf "$T"'

echo "== 5. README commands exist in the CLI =="
for cmd in check route ask report tune sync-models serve; do
  check bash -c "grep -q 'cmd === \"$cmd\"' src/cli.ts && grep -q 'tiershift $cmd' README.md"
done

echo "== 6. Jev model is pinned, not floating =="
check bash -c 'grep -qE "^\s*model:\s*jev-[0-9]+\.[0-9]+\.[0-9]+" tiershift.yaml'
check bash -c '! grep -rn "jev-latest" src/ --include=*.ts | grep -v test | grep -q .'

echo "== 7. conformance fixtures pass in both packages =="
check npx vitest run src/conformance.test.ts
if [ -d python ]; then check bash -c 'cd python && uv run pytest -q tests/test_conformance.py'; fi

echo "== 8. version and changelog agree =="
check bash -c 'V=$(node -p "require(\"./package.json\").version"); grep -q "## \[$V\]" CHANGELOG.md'
if [ -f python/pyproject.toml ]; then check bash -c 'V=$(node -p "require(\"./package.json\").version"); grep -q "version = \"$V\"" python/pyproject.toml'; fi

echo "== 9. commit hygiene: no co-author lines on this project =="
check bash -c '! git log --format=%B | grep -qi "co-authored-by"'

echo
if [ "$fails" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$fails CHECK(S) FAILED"; exit 1; fi
