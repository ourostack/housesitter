#!/bin/sh
# Housesitter memory sampler: every 30 s, one CSV line with the Comet's memory, the sitter's heartbeat
# (status.json "at", written every look) and what the agent's processes hold. Lives in /userdata, so samples survive reboots.
OUT=${1:-/userdata/ouro/samples/mem.csv}
mkdir -p "$(dirname "$OUT")"
[ -s "$OUT" ] || echo "at_utc,epoch,mem_available_kb,mem_free_kb,sitter_at_ms,sitter_age_s,sitter_state,agent_rss_kb,agent_procs,python_rss_kb" > "$OUT"
while true; do
  now=$(date +%s)
  ma=$(awk '/^MemAvailable/{print $2}' /proc/meminfo); mf=$(awk '/^MemFree/{print $2}' /proc/meminfo)
  st=/etc/kvmd/user/housesitter/status.json
  sat=$(sed -n 's/.*"at": *\([0-9]*\).*/\1/p' "$st" 2>/dev/null | head -1)
  sstate=$(sed -n 's/.*"state": *"\([a-z_-]*\)".*/\1/p' "$st" 2>/dev/null | head -1)
  age=""; [ -n "$sat" ] && age=$(( now - sat / 1000 ))
  arss=0; an=0; prss=0
  for p in /proc/[0-9]*; do
    c=$(tr '\0' ' ' < $p/cmdline 2>/dev/null)
    r=$(awk '/^VmRSS/{print $2}' $p/status 2>/dev/null)
    [ -z "$r" ] && continue
    case "$c" in
      */userdata/ouro/*node*|*ouro*daemon*|*housesitter/plugin*|*plugins/housesitter*) arss=$((arss + r)); an=$((an + 1)) ;;
      *sitter.py*) prss=$((prss + r)) ;;
    esac
  done
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ),$now,$ma,$mf,$sat,$age,$sstate,$arss,$an,$prss" >> "$OUT"
  sleep 30
done
