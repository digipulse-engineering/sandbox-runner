#!/bin/sh
set -eu

source_dir=$1
destination=$2
expected_commit=${3-}
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME='Sandbox Runner' GIT_AUTHOR_EMAIL='qualification@example.invalid'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_DATE='2000-01-01T00:00:00+00:00'
export GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"

mkdir "$destination"
for file in package.json package-lock.json pass.test.mjs fail.test.mjs offline.test.mjs; do
  install -m 0644 "$source_dir/$file" "$destination/$file"
done
cd "$destination"
git init -q --initial-branch=main --object-format=sha1
git -c core.autocrlf=false add -- package.json package-lock.json pass.test.mjs fail.test.mjs offline.test.mjs
git -c commit.gpgsign=false commit -q -m 'Synthetic Vitest qualification fixture'
actual_commit=$(git rev-parse HEAD)
if [ -n "$expected_commit" ] && [ "$actual_commit" != "$expected_commit" ]; then
  printf 'Fixture commit differs from pin: %s\n' "$actual_commit" >&2
  exit 1
fi
printf '%s\n' "$actual_commit"
