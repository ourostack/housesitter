#!/bin/sh
# The probes behind these files: can a new TCP connection reach the Comet's SSH, HTTP and HTTPS?
# Run on the laptop (home LAN, not on the tailnet); it runs the same probes on ouroboros-host (LAN and tailnet) over SSH.
# Addresses are left out of this file and of what it prints.
# usage: HS_LAN=<the KVM's LAN address> HS_TAILNET=<its tailnet address> probe.sh <label>
LAN=${HS_LAN:?set HS_LAN to the LAN address of the KVM}
TAILNET=${HS_TAILNET:?set HS_TAILNET to the tailnet address of the KVM}
probe='p() { for port in 22 80 443; do if nc -z -G 4 "$2" $port 2>/dev/null; then echo "  $1 :$port OPEN"; else echo "  $1 :$port no answer (4 s)"; fi; done; }'
echo "$1, $(date -u +%H:%M:%SZ)"
echo "laptop (on the LAN, not on the tailnet):"
sh -c "$probe; p LAN $LAN"
echo "ouroboros-host (on the LAN and the tailnet):"
ssh -o BatchMode=yes -o ConnectTimeout=6 arimendelow@ouroboros-host.local "$probe; p LAN $LAN; p tailnet $TAILNET"
