#!/usr/bin/env bash
# PRD Appendix A.6 — two different logins must produce two different identities.
set -euo pipefail
BASE="${BASE:-http://127.0.0.1:${TEST_SERVER_PORT:-3003}}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT   # jars contain session cookies

curl -sf -c "$TMP/customer.jar" -L "$BASE/login?user=customer" >/dev/null
curl -sf -c "$TMP/provider.jar" -L "$BASE/login?user=provider" >/dev/null
c="$(curl -sf -b "$TMP/customer.jar" "$BASE/whoami")"
p="$(curl -sf -b "$TMP/provider.jar" "$BASE/whoami")"
echo "customer jar -> $c"
echo "provider jar -> $p"

[[ "$c" == *'"identity":"customer"'* && "$p" == *'"identity":"provider"'* ]] \
  && echo "OK: identities are distinct" \
  || { echo "FAIL: unexpected identities" >&2; exit 1; }
