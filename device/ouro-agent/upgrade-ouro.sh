#!/bin/sh
# In-place upgrade of @ouro.bot/cli on the Comet (no room for a second copy on /userdata).
# usage: upgrade-ouro.sh <new-version>
set -e
. /userdata/ouro/env.sh
NEW="$1"; C="$HOME/.ouro-cli"; OLD=$(basename "$(readlink "$C/CurrentVersion")")
echo "$(date -u +%FT%TZ) upgrade $OLD -> $NEW; MemAvailable $(awk '/MemAvailable/{print $2}' /proc/meminfo) kB"
/etc/init.d/S99ouro stop || true
sleep 3
npm config get omit | grep -q optional || npm config set omit optional
NODE_OPTIONS=--max-old-space-size=256 npm install --prefix "$C/versions/$OLD" "@ouro.bot/cli@$NEW" --omit=dev --no-audit --no-fund
mv "$C/versions/$OLD" "$C/versions/$NEW"
ln -sfn "$C/versions/$NEW" "$C/CurrentVersion"
VU="$C/versions/$NEW/node_modules/@ouro.bot/cli/dist/repertoire/vault-unlock.js"
# From 0.1.0-alpha.1018 the CLI reads OURO_VAULT_UNLOCK_STORE itself; patch only older releases.
grep -q OURO_VAULT_UNLOCK_STORE "$VU" || python3 /userdata/ouro/bin/hotfix-unlock-store.py "$VU"
/etc/init.d/S99ouro start
echo "$(date -u +%FT%TZ) done; MemAvailable $(awk '/MemAvailable/{print $2}' /proc/meminfo) kB"
