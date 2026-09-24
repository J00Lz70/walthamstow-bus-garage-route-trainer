#!/usr/bin/env bash
# Prints the web app's address: the APP_URL repository variable if set, otherwise the GitHub Pages address.
set -euo pipefail
if [ -n "${APP_URL:-}" ]; then
  url="$APP_URL"
else
  owner=$(echo "$GITHUB_REPOSITORY_OWNER" | tr '[:upper:]' '[:lower:]')
  repo="${GITHUB_REPOSITORY#*/}"
  if [ "$(echo "$repo" | tr '[:upper:]' '[:lower:]')" = "${owner}.github.io" ]; then
    url="https://${owner}.github.io/"
  else
    url="https://${owner}.github.io/${repo}/"
  fi
fi
case "$url" in */) ;; *) url="$url/" ;; esac
echo "$url"
