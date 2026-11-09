#!/bin/sh
# Away mode on the real Comet, and the sitter putting home back by itself. Run on the laptop from this folder. It
# restarts the sitter (which applies home), and 200 s later applies away, so the sitter's own 5-minute recheck finds it.
# Away is applied over the tailnet (through ouroboros-host), the only way in once it holds. A dead-man job on the Comet
# applies home 200 s after away, in case the sitter doesn't. Addresses are left out of this file and of what it writes.
# usage: HS_LAN=<the KVM's LAN address> HS_TAILNET=<its tailnet address> away-test.sh
set -u
: "${HS_LAN:?set HS_LAN}" "${HS_TAILNET:?set HS_TAILNET}"
OPTS="-i $HOME/.ssh/housesitter-mini-ecdsa -o UserKnownHostsFile=$HOME/.ssh/housesitter-mini-known_hosts -o BatchMode=yes -o ConnectTimeout=8 -o LogLevel=ERROR -o HostKeyAlias=$HS_LAN"
TS="ssh $OPTS -J arimendelow@ouroboros-host.local root@$HS_TAILNET"
D=/etc/kvmd/user/housesitter
HIDE="sed -E -e 's/$HS_LAN/<LAN>/g' -e 's/$HS_TAILNET/<tailnet>/g' -e 's/fd7a:[0-9a-f:]+/<tailnet v6>/g' -e 's/fe80:[0-9a-f:]+/<link-local>/g'"
READ='echo "iptables -S HOUSESITTER_IN:"; iptables -S HOUSESITTER_IN; echo "iptables -S INPUT:"; iptables -S INPUT; echo "IPv6 off (disable_ipv6) per interface:"; for i in $(ls /proc/sys/net/ipv6/conf); do echo "  $i $(cat /proc/sys/net/ipv6/conf/$i/disable_ipv6)"; done'
APPLY_AWAY="cd $D; date -u +'applied at %H:%M:%SZ'; python3 -c 'import sitter; print(sitter.apply_ingress(\"tailnet\"))'; ($READ); (sleep 200; python3 -c 'import sitter; print(sitter.apply_ingress(\"lan\"))' > dead-man.log 2>&1) > /dev/null 2>&1 &"

$TS "mv -f $D/dead-man.log $D/dead-man.log.prev 2>/dev/null; /etc/init.d/S99housesitter restart" > /dev/null 2>&1
sleep 200
$TS "date -u +'at %H:%M:%SZ'; sha256sum $D/sitter.py; echo; echo 'Listening sockets (netstat -tulnp):'; netstat -tulnp" 2>&1 | sh -c "$HIDE" > 0-what-runs-and-listens.txt
./probe.sh "home, before" > 1-probes-home.txt 2>&1
AWAY_AT=$(date +%s)
$TS "$APPLY_AWAY" 2>&1 | sh -c "$HIDE" > 2-apply-away.txt
./probe.sh "away, applied over the tailnet" > 3-probes-away.txt 2>&1
for n in $(seq 1 40); do
  if $TS "awk '/start: sitter/{d=0} /ingress drifted/{d=1} END{exit !d}' $D/sitter.log" 2>/dev/null; then break; fi
  sleep 6
done
sleep 4
$TS "date -u +'read at %H:%M:%SZ'; echo 'sitter.log, ingress lines, since this sitter started:'; awk '/start: sitter/{n=NR} {l[NR]=\$0} END{for(i=n;i<=NR;i++) print l[i]}' $D/sitter.log | grep -E 'start: sitter|ingress'; ($READ)" 2>&1 | sh -c "$HIDE" > 4-sitter-puts-home-back.txt
./probe.sh "home, put back by the sitter" > 5-probes-home.txt 2>&1
sleep $((AWAY_AT + 215 - $(date +%s)))
$TS "date -u +'read at %H:%M:%SZ'; ls -l --time-style=+%H:%M:%SZ $D/dead-man.log | awk '{print \"dead-man.log written\", \$6}'; cat $D/dead-man.log; echo; echo 'ingress.json:'; cat $D/ingress.json" 2>&1 | sh -c "$HIDE" > 6-dead-man-and-ingress-json.txt
cat 0-what-runs-and-listens.txt 1-probes-home.txt 2-apply-away.txt 3-probes-away.txt 4-sitter-puts-home-back.txt 5-probes-home.txt 6-dead-man-and-ingress-json.txt
