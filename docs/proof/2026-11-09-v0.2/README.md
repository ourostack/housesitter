# housesitter 0.2 on the real Comet: redeploy, a hands-off restart, one TEST alert (2026-11-09 UTC)

Asked for tonight, while the mini was idle (HID idle for 1,370 s, no osascript, and the UI agent's gate mark 49 min old).

## 1. Redeploy (housesitter main, with #22 and then #23)

- `device/sitter.py` was copied to the Comet: `1138cb5e…` at 06:54, then `b359e5bf…` (main `630abe7`, which adds alert-test) at 07:04.
- Re-storing the same Mac password answered `{"unchanged": true, "trust": "verified"}`. The password stayed **verified** throughout.
- The sitter log at start reads `ingress: SSH and HTTPS from the LAN and the tailnet; IPv6: nothing to filter at home (ip6tables unavailable…)`.
- Rules read back from the Comet ([ingress-readback.txt](ingress-readback.txt)): `INPUT` jumps to `HOUSESITTER_IN`, then `ts-input`, then `MACW_IN`.
  - **At home `HOUSESITTER_IN` is applied and empty by design:** the LAN and the tailnet may reach SSH and HTTPS.
  - The DROPs for 22/443, which leave only `tailscale0`, appear in `--location away`. That isn't exercised here, because it would cut off this laptop, which isn't on the tailnet.
  - `ip6tables` has no filter table on this firmware. eth0 has only a link-local IPv6 address.

## 2. One hands-off restart on 0.2 ([proof](proof/), [sitter.log](sitter.log), [the KVM's own HID log](kvmd-access-hid-0654-0702.log))

| UTC | What happened (source of record) |
|---|---|
| 06:55:31–32 | Apple menu: mouse move and click **from 192.168.50.113, this laptop** (kvmd access log). An agent pressed Restart, and we say so. |
| 06:55:42–43 | Restart…: mouse moves and click, from the laptop. |
| 06:55:55.7 | Return in the restart dialog, from the laptop. **Hands off from here.** |
| 06:56:24 | `boot-watch: boot seen (a restart, or a wake)…` |
| 06:56:44 | `the Mac booted and the FileVault prompt it was taught is on the KVM's picture (steady for 6 frames)`. kvmd logs `send_key` (a lone Shift wake) from `-`, the KVM's own socket, which is the sitter. |
| 06:56:50–51 | kvmd logs `/hid/print` then `send_key` (Enter), both from `-`. The sitter: `unlock: typed the password at the FileVault prompt it was taught (frame, password verified)`. |
| 06:57:06 | `the desktop is up after the boot` |

**From Restart to desktop: 70 s** (06:55:55.7 → 06:57:06). From boot seen to desktop: 42 s. The proof stopped by itself at 06:57:47, after 41 looks.

**Nobody else pressed anything, on the device's own record.** In 06:54–07:02, kvmd's access log (syslog, `aiohttp.access`) shows only:
- the laptop's 8 restart events;
- the sitter's 3 (Shift, the password `print` with no body logged, and Enter);
- 68 `/ws?stream=1` sessions: 66 from the sitter and the proof warming the encoder, and 2 from the laptop's menu and dialog checks.

Caveat: kvmd logs a WebSocket session, not the HID events sent inside one. None of our code sends HID over a WebSocket, but the log alone can't show that.

**Frames:** the proof kept 15 frames out of 41 looks (14 are published here): shutdown, the Apple logo with a progress bar, the FileVault prompt, then the login progress. I removed one frame by hand: a logout frame still showing the Dock, with an unread badge. The sitter read it as `prompt_like` because it has no menu bar ([timeline.json](proof/timeline.json) marks it). Reported upstream.

**After the restart** ([health-after.txt]):
- Hub: online.
- macd: answering on the bus.
- Reins agent: running, with Accessibility and Screen Recording.
- Copilot app: running.
- `caffeinate -d -i -m` and the Hub session-manager: up.
- Drains: one detector each, `DETECTOR-REARMED` 6550 (m365crawl) at 10:58 PM PT and 7254 (desk) at 10:59 PM PT.

## 3. One real "I'm stuck" alert, end to end, marked TEST

`housesitter alert-test mini`, which is new in [#23](https://github.com/ourostack/housesitter/pull/23) and was written for this:
1. The sitter's own rules (`tick` → `decide`) are handed a Mac that has sat at FileVault past `filevault_wait_min` with nothing able to unlock it.
2. They choose their own notify action.
3. `perform_notify` sends it through `notify()`, the same path every real message takes, to the configured channel (ntfy).
4. "TEST" is the first word of the title and of the body.
5. It is ledgered as a `notify` with `test: true`, and the sitter's real memory is untouched.

Sent at 07:05:31; ntfy's own record ([ntfy-record.jsonl](ntfy-record.jsonl)) has it at 07:05:32. The topic is not in the record; it lives in `~/.config/housesitter/config.json`:

> **TEST: mini is stuck at FileVault**
> TEST (housesitter alert-test; nothing is wrong). Seen by the housesitter on its KVM.
> Stuck because: at the FileVault screen for 10+ min and the sitter has not unlocked it. Look: housesitter status mini.
> Signs: arp=True, eyes=frame, screen=filevault, video=True.

Only one was sent. The channel is ntfy alone, because HEY isn't wired into housesitter. Ari's phone gets it only if it is subscribed to that topic.
