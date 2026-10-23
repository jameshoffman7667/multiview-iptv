#!/usr/bin/env bash
# Decides whether this workflow run is a release and checks that it may be one.
# Writes version, release (true/false) and source (main/tag) to $GITHUB_OUTPUT.
# Environment: EVENT (github.event_name), REF_TYPE, REF_NAME, BEFORE (github.event.before), GH_TOKEN.
set -euo pipefail
out() { echo "$1=$2" >> "${GITHUB_OUTPUT:-/dev/stdout}"; }
fail() { echo "::error::$1"; exit 1; }

if [ "${EVENT:-}" = workflow_dispatch ]; then out release false; echo "Manual run: no release."; exit 0; fi

VER="$(node -p "require('./package.json').version")"
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "package.json version '$VER' is not X.Y.Z"
TAG="v$VER"
SOURCE=main

if [ "${REF_TYPE:-}" = tag ]; then
  # fallback: a tag was pushed by hand
  SOURCE=tag
  [ "$REF_NAME" = "$TAG" ] || fail "tag $REF_NAME does not match package.json version $VER"
  if gh release view "$TAG" >/dev/null 2>&1; then fail "a release for $TAG already exists (the push to main already released it)"; fi
else
  # push to main: only a changed version is a release
  OLD=""
  if [[ -n "${BEFORE:-}" && ! "$BEFORE" =~ ^0+$ ]] && git cat-file -e "$BEFORE^{commit}" 2>/dev/null; then
    OLD="$(git show "$BEFORE:package.json" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version||"")}catch(e){console.log("")}})')" || OLD=""
  fi
  if [ "$OLD" = "$VER" ]; then out release false; echo "Version $VER is unchanged: not a release."; exit 0; fi
  if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then fail "tag $TAG already exists - bump the version in package.json"; fi
fi

# the CHANGELOG entry: "## X.Y.Z - YYYY-MM-DD" followed by some text
HEAD_RE="^## ${VER//./\\.} - [0-9]{4}-[0-9]{2}-[0-9]{2}\$"
grep -qE "$HEAD_RE" CHANGELOG.md || fail "CHANGELOG.md has no entry '## $VER - YYYY-MM-DD'"
BODY="$(awk -v re="$HEAD_RE" '$0 ~ re {f=1; next} /^## / {f=0} f' CHANGELOG.md)"
[ -n "$(printf '%s' "$BODY" | tr -d '[:space:]')" ] || fail "the CHANGELOG entry for $VER is empty"

out version "$VER"
out release true
out source "$SOURCE"
echo "Releasing $TAG from $SOURCE."
