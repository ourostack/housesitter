# Who can reach the KVM, on the real Comet: home, away, and the sitter putting it back (#27)

9 November 2026, on our GL.iNet Comet (GL-RM1PE, kvmd 4.82) at home, running housesitter 0.3.2's sitter: `device/sitter.py` with SHA-256 `1485b8b989eba7b74eb0616087c90052623212bf3ba3e7910dab512a63457219`, read on the Comet in [0-what-runs-and-listens.txt](0-what-runs-and-listens.txt). Probed from two machines: our laptop on the home LAN (not on the tailnet), and ouroboros-host, a Mac on both the LAN and the tailnet. [away-test.sh](away-test.sh) is the whole run and [probe.sh](probe.sh) the probe; addresses are left out of both and of their output.

| UTC | What | Laptop, LAN | ouroboros-host, LAN | ouroboros-host, tailnet |
| --- | --- | --- | --- | --- |
| 23:04:00 | The sitter starts and applies **home**, read back (probed at 23:07:23) | 22, 80, 443 open | open | open |
| 23:07:27 | **Away** applied over the tailnet, read back | no answer | no answer | 22, 80, 443 open |
| 23:09:01 | The sitter's own 5-minute recheck finds the chain isn't home, and puts home back | open | open | open |

Away held for 94 seconds, under the 5 minutes after which the Mac's own watch of its KVM would have called it silent.

## The files

- [0-what-runs-and-listens.txt](0-what-runs-and-listens.txt): the sitter's hash, and every listening socket on the Comet (`netstat -tulnp`).
- [1-probes-home.txt](1-probes-home.txt): home, before.
- [2-apply-away.txt](2-apply-away.txt): away, applied with the sitter's own `apply_ingress("tailnet")` (the function `harden` and the sitter's loop call), over SSH through the tailnet, the only way in once it holds. The readback: `lo` and `tailscale0` are let through, then 22, 80 and 443 are dropped; INPUT jumps to the chain first; IPv6 is off on `eth0` and `sit0`, and on only for `lo` and `tailscale0`.
- [3-probes-away.txt](3-probes-away.txt): from the LAN, nothing answers on 22, 80 or 443, from either machine; over the tailnet, all three answer.
- [4-sitter-puts-home-back.txt](4-sitter-puts-home-back.txt): the sitter's log, `ingress drifted (… missing: -s 10.0.0.0/8 -j RETURN, …); putting it back` at 23:09:01, and the chain read back as home: `lo`, `tailscale0`, 10/8, 172.16/12 and 192.168/16 let through, then the three DROPs.
- [5-probes-home.txt](5-probes-home.txt): both machines reach it over the LAN again.
- [6-dead-man-and-ingress-json.txt](6-dead-man-and-ingress-json.txt): a dead-man job, started with away, applied home again at 23:10:48 in case the sitter hadn't; and `ingress.json`, which the sitter keeps and `housesitter status` shows.
- [7-a-refused-change-keeps-the-rules.txt](7-a-refused-change-keeps-the-rules.txt): on the real chain, a transaction the kernel refuses (it asks for connection tracking) leaves the chain as it was.
- [8-proof-saves-the-kvm-log.txt](8-proof-saves-the-kvm-log.txt): what `housesitter proof` saved from the Comet's log.

## What it doesn't show

- No address outside the private ranges was tried at home: the Comet sits behind our router, so nothing public can reach it to be dropped. The rule is in the readback; it wasn't exercised.
- Only TCP 22, 80 and 443 are filtered. The socket list shows what else listens on every interface: NTP (UDP 123), mDNS (UDP 5353, and one more port each for mdnsd and mDNSResponder) and tailscaled's own UDP ports. Everything else listens only on loopback or the tailnet address. Over IPv6 only `lo` and `tailscale0` speak at all.
- Home trusts every private address, so it is for a network you control. An office or café network is private too: use `--location away` there.
- Away was applied by the function `adopt --location away` runs, not by `adopt` itself, so the run could come back to home without a second adopt over the tailnet.

## Found on the way

- **The Comet has no connection tracking** (`Extension conntrack revision 0 not supported`). An earlier draft of this change, at 21:44 UTC, couldn't apply away mode for that reason. Now that rule is skipped where the kernel can't do it, and the sitter says so. Nothing is lost: the DROPs cover only 22, 80 and 443, and replies to the KVM's own connections (ntfy, the tailnet, GitHub) arrive on other ports. A session that's open from a place the new mode doesn't allow ends when the mode changes.
- **The draft's readback only checked that the right words were there**, so a weakened rule (`! -i lo`, a DROP narrowed to one interface, `! --dport 22`, an ACCEPT before the jump) passed. Now each family's rules are compared line for line with what was written, and INPUT must jump to the chain first, once; tests cover each of those weakenings.
- **The draft flushed the chain, then added rules one at a time**, so a failure partway left the KVM unfiltered. Now each family is one `iptables-restore --noflush` transaction, and on the Comet a refused line leaves the chain as it was ([7-a-refused-change-keeps-the-rules.txt](7-a-refused-change-keeps-the-rules.txt), by [refused-change.sh](refused-change.sh)). If the rules can't be put in place for 5 minutes, the sitter tells you once, and `housesitter status` says it isn't filtering.
- **Rules can change after they're read back.** The sitter reads them back every 5 minutes and puts them back if they differ, as at 23:09:01.

## The KVM's access log (the third item on #27)

kvmd writes to syslog, and BusyBox keeps that in memory: about 45 minutes on our Comet. [The 0.2 extract](../2026-11-09-v0.2/kvmd-access-hid-0654-0702.log) holds only the `/ws` and `/hid/` requests among kvmd's `aiohttp.access` lines, so it was filtered further than `aiohttp.access`, and the exact command wasn't kept. Its window (06:54–07:02 UTC) left the buffer the same morning, so the unfiltered window can't be published now. From 0.3.2, `housesitter proof` saves the whole buffer (`syslog.log`) and the extract (`kvmd-access.log`, every `aiohttp.access` line) next to the frames when it stops, with the command, `logread | grep 'kvmd: aiohttp.access'`, written into `timeline.json`. We ran it against the Comet: it saved 7,865 lines (21:25:53 to 22:10:27) and 478 access lines, the command's exact output ([8-proof-saves-the-kvm-log.txt](8-proof-saves-the-kvm-log.txt)). `syslog.log` holds addresses, so check against it rather than publish it whole.
