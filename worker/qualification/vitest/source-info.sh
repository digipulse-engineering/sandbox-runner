#!/bin/sh
set -eu

changes=$(git status --porcelain)
test -z "$changes"
git rev-parse HEAD
node --version
