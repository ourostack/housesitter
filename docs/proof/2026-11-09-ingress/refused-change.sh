#!/bin/sh
# Does a refused iptables-restore transaction leave HOUSESITTER_IN as it was? On the real chain, with a transaction
# that would flush it and put in the away rules, but asks for connection tracking, which the Comet's kernel refuses.
# usage: HS_LAN=<the KVM's LAN address> refused-change.sh > 7-a-refused-change-keeps-the-rules.txt
: "${HS_LAN:?set HS_LAN}"
ssh -i "$HOME/.ssh/housesitter-mini-ecdsa" -o "UserKnownHostsFile=$HOME/.ssh/housesitter-mini-known_hosts" -o BatchMode=yes -o ConnectTimeout=8 -o LogLevel=ERROR "root@$HS_LAN" '
cd /etc/kvmd/user/housesitter
date -u +"at %H:%M:%SZ"; sha256sum sitter.py
echo "before:"; iptables -S HOUSESITTER_IN | tee .before-refused
T=$(printf "*filter\n:HOUSESITTER_IN - [0:0]\n-A HOUSESITTER_IN -i lo -j RETURN\n-A HOUSESITTER_IN -i tailscale0 -j RETURN\n-A HOUSESITTER_IN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN\n-A HOUSESITTER_IN -p tcp --dport 22 -j DROP\nCOMMIT\n")
echo; echo "the transaction:"; echo "$T" | sed "s/^/  /"
echo "$T" | iptables-restore --noflush > .refused-out 2>&1; rc=$?
sed "s/^/  stderr: /" .refused-out; echo "iptables-restore exit $rc"
echo; echo "after:"; iptables -S HOUSESITTER_IN
iptables -S HOUSESITTER_IN | cmp -s - .before-refused && echo "after == before: unchanged" || echo "CHANGED"'
