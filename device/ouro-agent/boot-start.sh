#!/bin/sh
# Run every minute from root's crontab. After the 2026-11-10 reboot test, rcS never started the S99housesitter* or
# S99ouro scripts, so this doesn't depend on it. Every run: the sitter (an idempotent start; a no-op while it runs).
# First run after each boot (marker in /run, which is tmpfs): Housesitter's sampler, daemon and watcher. Once per
# boot only, so the ouro supervisor's own circuit breaker and a deliberate `ouro stop` are respected.
LOG=/userdata/ouro/samples/boot-start.log
/etc/init.d/S99housesitter status >/dev/null 2>&1 || { /etc/init.d/S99housesitter start; echo "$(date -u +%FT%TZ) started the sitter" >>$LOG; }
M=/run/housesitter-boot-started
[ -f $M ] && exit 0
touch $M
for s in S99housesitter-samples S99ouro S99housesitter-watch; do
  /etc/init.d/$s start >/dev/null 2>&1
  echo "$(date -u +%FT%TZ) boot start $s: $(/etc/init.d/$s status 2>&1 | tail -1)" >>$LOG
done
