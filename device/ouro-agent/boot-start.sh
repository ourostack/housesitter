#!/bin/sh
# Run every minute from root's crontab. After the 2026-11-10 reboot test, rcS never started the S99housesitter* or
# S99ouro scripts, so this doesn't depend on it. Every run: the sitter (an idempotent start; a no-op while it runs),
# and the video encoder's memory (below). First run after each boot (marker in /run, which is tmpfs): Housesitter's
# sampler, daemon and watcher. Once per boot only, so the ouro supervisor's own circuit breaker and a deliberate
# `ouro stop` are respected.
LOG=/userdata/ouro/samples/boot-start.log
/etc/init.d/S99housesitter status >/dev/null 2>&1 || { /etc/init.d/S99housesitter start; echo "$(date -u +%FT%TZ) started the sitter" >>$LOG; }
# kvmd's streamer needs 64 KB (order-4) contiguous kernel blocks to start its encoder. This kernel has no compaction,
# so when free memory fragments the encoder fails ("open valloc failed", "page allocation failure: order:4") and the
# sitter loses its picture (2026-11-10: 117 of 144 starts failed in half an hour). Dropping the page cache lets the
# freed pages merge back; it costs only re-reads. Done only when order-4-and-up free blocks fall under FRAG_MIN.
FRAG_MIN=250
big=$(awk '/Normal/{n=0; for(i=9;i<=NF;i++) n+=$i; print n}' /proc/buddyinfo)
if [ -n "$big" ] && [ "$big" -lt "$FRAG_MIN" ]; then
  sync; echo 1 > /proc/sys/vm/drop_caches
  echo "$(date -u +%FT%TZ) fragmented ($big free blocks of 64 KB+): dropped the page cache, now $(awk '/Normal/{n=0; for(i=9;i<=NF;i++) n+=$i; print n}' /proc/buddyinfo)" >>$LOG
fi
M=/run/housesitter-boot-started
[ -f $M ] && exit 0
touch $M
for s in S99housesitter-samples S99ouro S99housesitter-watch; do
  /etc/init.d/$s start >/dev/null 2>&1
  echo "$(date -u +%FT%TZ) boot start $s: $(/etc/init.d/$s status 2>&1 | tail -1)" >>$LOG
done
