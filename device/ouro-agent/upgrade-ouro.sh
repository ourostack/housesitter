#!/bin/sh
# Hand-install @ouro.bot/cli <version> on the Comet: a fresh, lean install into its own versions/<version> folder (the
# in-place way kept stale packages: 321 MB against 76 MB fresh), then switch to it. Refuses unless free /userdata
# >= the current install's size + 64 MiB and MemAvailable >= 250 MB. The old version stays as the rollback.
# usage: upgrade-ouro.sh <new-version>
set -e
. /userdata/ouro/env.sh
NEW="$1"; C="$HOME/.ouro-cli"; OLD=$(basename "$(readlink "$C/CurrentVersion")")
[ -n "$NEW" ] || { echo "usage: upgrade-ouro.sh <version>"; exit 2; }
[ "$NEW" != "$OLD" ] || { echo "already on $NEW"; exit 0; }
need=$(( $(du -sk "$C/versions/$OLD" | cut -f1) + 65536 )); free=$(df -k /userdata | awk 'NR==2{print $4}')
mem=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
echo "$(date -u +%FT%TZ) upgrade $OLD -> $NEW; free ${free} kB (need ${need}); MemAvailable ${mem} kB (floor 256000)"
[ "$free" -ge "$need" ] || { echo "REFUSED: free /userdata ${free} kB < install size + 64 MiB = ${need} kB"; exit 3; }
[ "$mem" -ge 256000 ] || { echo "REFUSED: MemAvailable ${mem} kB < 250 MB floor"; exit 3; }
npm config get omit | grep -q optional || npm config set omit optional
T="$C/versions/.installing-$NEW"
mkdir -p "$T"
echo 1000 > /proc/self/oom_score_adj
NODE_OPTIONS=--max-old-space-size=256 nice -n 10 npm install --prefix "$T" "@ouro.bot/cli@$NEW" --omit=dev --omit=optional --no-audit --no-fund
VU="$T/node_modules/@ouro.bot/cli/dist/repertoire/vault-unlock.js"
grep -q OURO_VAULT_UNLOCK_STORE "$VU" || python3 /userdata/ouro/bin/hotfix-unlock-store.py "$VU"
mv "$T" "$C/versions/$NEW"
/etc/init.d/S99ouro stop || true
sleep 2
ln -sfn "$C/versions/$NEW" "$C/CurrentVersion"
# Hand-installed on purpose: the version intent follows ("latest"), so a 1020-era rollback pin does not hold the new one back.
printf '{\n  "schemaVersion": 1,\n  "mode": "latest",\n  "targetVersion": "%s"\n}\n' "$NEW" > "$C/version-intent.json.new" && chmod 600 "$C/version-intent.json.new" && mv "$C/version-intent.json.new" "$C/version-intent.json"
/etc/init.d/S99ouro start
echo "$(date -u +%FT%TZ) done: $(du -sm "$C/versions/$NEW" | cut -f1) MB; MemAvailable $(awk '/MemAvailable/{print $2}' /proc/meminfo) kB; free $(df -k /userdata | awk 'NR==2{print $4}') kB"
