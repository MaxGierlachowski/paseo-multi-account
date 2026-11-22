#!/usr/bin/env bash
# Installs the release tarball into a throwaway headless Paseo daemon and checks the account
# contract end to end: load, list, switch, add, reload behaviour, remove, and degraded logins.
#
#   scripts/smoke-linux.sh dist/paseo-multi-account-<version>.tgz
#
# Needs `paseo` (@getpaseo/cli 0.17.x) and node on PATH; no network. Every credential it writes
# is fake. With `claude` on PATH it also checks the account a new Claude session runs on.
set -euo pipefail

TARBALL=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
PORT=${PORT:-6767}
WORK=$(mktemp -d)
export PASEO_HOME=$WORK/paseo
ACCOUNTS_DIR=$WORK/accounts
PLUGIN_ID=claude-accounts-usage
DAEMON_PID=

cleanup() {
  [ -n "$DAEMON_PID" ] && paseo daemon stop --home "$PASEO_HOME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
json() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const v=JSON.parse(d);console.log(String($1))})"; }

fake_login() { # dir token hours-valid
  mkdir -p -m 700 "$1"
  local expires=$(( ($(date +%s) + $3 * 3600) * 1000 ))
  printf '{"claudeAiOauth":{"accessToken":"%s","refreshToken":"%s-refresh","expiresAt":%s,"scopes":["user:inference","user:profile"],"subscriptionType":"max"}}' \
    "$2" "$2" "$expires" > "$1/.credentials.json"
  chmod 600 "$1/.credentials.json"
}

step "daemon config in $PASEO_HOME"
mkdir -p "$PASEO_HOME"
paseo daemon config set --home "$PASEO_HOME" daemon.listen "127.0.0.1:$PORT" >/dev/null
paseo daemon config set --home "$PASEO_HOME" daemon.relay.enabled false >/dev/null
paseo daemon config set --home "$PASEO_HOME" features.webUi.enabled false >/dev/null
paseo daemon config set --home "$PASEO_HOME" pluginsEnabled true >/dev/null
fake_login "$ACCOUNTS_DIR/claude-alpha" fake-token-alpha 6
fake_login "$ACCOUNTS_DIR/claude-beta" fake-token-beta 6
paseo daemon config set --home "$PASEO_HOME" agents.providers "$(cat <<JSON
{"claude-alpha":{"extends":"claude","label":"Claude (alpha)","enabled":false,"env":{"CLAUDE_CONFIG_DIR":"$ACCOUNTS_DIR/claude-alpha"}},
 "claude-beta":{"extends":"claude","label":"Claude (beta)","enabled":false,"env":{"CLAUDE_CONFIG_DIR":"$ACCOUNTS_DIR/claude-beta"}}}
JSON
)" >/dev/null

step "paseo daemon run (headless)"
paseo daemon run --home "$PASEO_HOME" >"$WORK/daemon.out" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 60); do
  curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fs "http://127.0.0.1:$PORT/api/health" || fail "daemon did not come up"

step "verify and extract $(basename "$TARBALL")"
mkdir -p "$WORK/vendor"
(cd "$(dirname "$TARBALL")" && sha256sum -c "$(basename "$TARBALL").sha256")
tar xzf "$TARBALL" -C "$WORK/vendor"
PLUGIN_DIR=$WORK/vendor/paseo-multi-account
ACCOUNTS=(node "$PLUGIN_DIR/bin/paseo-claude-accounts.mjs" --home "$PASEO_HOME")

step "paseo plugin install <dir>"
paseo plugin install "$PLUGIN_DIR" --home "$PASEO_HOME" 2>/dev/null | cut -c1-60
status=$(paseo plugin ls "$PLUGIN_ID" --home "$PASEO_HOME" --json | json 'v[0].status')
[ "$status" = running ] || fail "plugin status is $status"

step "list: both accounts, the first one active"
"${ACCOUNTS[@]}" list >"$WORK/list.json"
[ "$(json 'v.accounts.map(a=>a.id).join()' <"$WORK/list.json")" = "claude-alpha,claude-beta" ] || fail "accounts"
[ "$(json 'v.activeId' <"$WORK/list.json")" = claude-alpha ] || fail "active account"
echo ok

step "switch to beta (config level)"
"${ACCOUNTS[@]}" switch claude-beta | json 'JSON.stringify(v)'
[ "$(json 'v.activeAccountId' <"$PASEO_HOME/claude-accounts.json")" = claude-beta ] || fail "state"

step "missing and invalid logins degrade"
echo '{ not json' >"$ACCOUNTS_DIR/claude-beta/.credentials.json"
mv "$ACCOUNTS_DIR/claude-alpha/.credentials.json" "$WORK/alpha.bak"
"${ACCOUNTS[@]}" list --usage --force >"$WORK/list.json"
json 'v.accounts.map(a=>a.id+": "+a.usage.status+" ("+a.usage.message+")").join("\n")' <"$WORK/list.json"
[ "$(json 'v.accounts.filter(a=>a.usage.status==="unavailable").length' <"$WORK/list.json")" = 2 ] || fail "degraded list"
if "${ACCOUNTS[@]}" switch claude-alpha 2>"$WORK/err"; then fail "switch without login"; fi
cat "$WORK/err"
status=$(paseo plugin ls "$PLUGIN_ID" --home "$PASEO_HOME" --json | json 'v[0].status')
[ "$status" = running ] || fail "plugin status after degraded reads is $status"
mv "$WORK/alpha.bak" "$ACCOUNTS_DIR/claude-alpha/.credentials.json"
fake_login "$ACCOUNTS_DIR/claude-beta" fake-token-beta 6

step "usage of fake logins: listed; error offline, rejected online"
"${ACCOUNTS[@]}" list --usage --force | json 'v.accounts.map(a=>a.id+": "+a.usage.status+" ("+a.usage.message+")").join("\n")'

step "add through the plugin: applied at once"
"${ACCOUNTS[@]}" add Gamma --id claude-gamma --config-dir "$ACCOUNTS_DIR/claude-gamma" | json 'JSON.stringify(v)'
[ "$(stat -c %a "$ACCOUNTS_DIR/claude-gamma")" = 700 ] || fail "config dir mode"
paseo provider ls --home "$PASEO_HOME" | grep -q claude-gamma || fail "daemon does not know claude-gamma"
echo ok

step "hand edit of config.json: plugin at once, daemon after reload"
node -e '
const fs = require("fs"); const f = process.argv[1]; const c = JSON.parse(fs.readFileSync(f));
c.agents.providers["claude-delta"] = { extends: "claude", label: "Claude (delta)", enabled: false,
  env: { CLAUDE_CONFIG_DIR: process.argv[2] } };
fs.writeFileSync(f, JSON.stringify(c, null, 2));' "$PASEO_HOME/config.json" "$ACCOUNTS_DIR/claude-delta"
"${ACCOUNTS[@]}" list | grep -q '"claude-delta"' || fail "plugin does not see claude-delta"
if paseo provider ls --home "$PASEO_HOME" | grep -q claude-delta; then echo "daemon saw it before reload"; else echo "daemon: not yet"; fi
paseo daemon reload --home "$PASEO_HOME" --json | json 'v.appliedPaths.join()'
paseo provider ls --home "$PASEO_HOME" | grep -q claude-delta || fail "daemon does not know claude-delta after reload"
echo ok

step "remove: the active account is refused, another one goes"
if "${ACCOUNTS[@]}" remove claude-beta 2>"$WORK/err"; then fail "removed the active account"; fi
cat "$WORK/err"
"${ACCOUNTS[@]}" remove claude-gamma | json 'JSON.stringify(v)'
if paseo provider ls --home "$PASEO_HOME" | grep -q claude-gamma; then fail "claude-gamma still configured"; fi
echo ok

if command -v claude >/dev/null; then
  step "a new Claude session runs on the active account"
  mkdir -p "$WORK/repo"
  paseo agent run --home "$PASEO_HOME" --no-wait --json --provider claude --cwd "$WORK/repo" "reply ok" >/dev/null 2>&1 || true
  found=
  for _ in $(seq 20); do
    for pid in $(pgrep -f claude || true); do
      tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -qx "CLAUDE_CONFIG_DIR=$ACCOUNTS_DIR/claude-beta" && found=$pid
    done
    [ -n "$found" ] && break
    sleep 1
  done
  [ -n "$found" ] || fail "no Claude process on claude-beta"
  echo "pid $found: CLAUDE_CONFIG_DIR=$ACCOUNTS_DIR/claude-beta"
fi

printf '\nPASS\n'
