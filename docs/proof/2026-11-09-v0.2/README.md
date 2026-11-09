# housesitter 0.2 on the real Comet: redeploy, a hands-off restart, one TEST alert (2026-11-09 UTC)

Asked for tonight, while the mini was idle (HID idle for 1,370 s, no osascript, and the UI agent's gate mark 49 min old).

## 1. Redeploy (housesitter main, with #22 and then #23)

- `device/sitter.py` was copied to the Comet: `1138cb5e…` at 06:54, then `b359e5bf…` (main `630abe7`, which adds alert-test) at 07:04.
- Re-storing the same Mac password answered `{"unchanged": true, "trust": "verified"}`. The password stayed **verified** throughout.
- The sitter log at start reads `ingress: SSH and HTTPS from the LAN and the tailnet; IPv6: nothing to filter at home (ip6tables unavailable…)`.
- Rules read back from the Comet ([ingress-readback.txt](ingress-readback.txt)): `INPUT` jumps to `HOUSESITTER_IN`, then `ts-input`, then `MACW_IN`.
  - **At home `HOUSESITTER_IN` is applied and empty by design, so it filters nothing:** anything that reaches the KVM may use SSH and HTTPS. Here that is the home LAN and the tailnet, behind the home router; the rules themselves don't enforce it.
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

Caveats: kvmd logs a WebSocket session, not the HID events sent inside one. None of our code sends HID over a WebSocket, but the log alone can't show that. [kvmd-access-hid-0654-0702.log](kvmd-access-hid-0654-0702.log) holds the `aiohttp.access` lines taken from the KVM's syslog for the window; its last entry is 06:59:15, and the unfiltered syslog and the extraction command aren't published, so "only" rests on that extract.

**Frames:** the proof kept 15 frames out of 41 looks (14 are published here): shutdown, the Apple logo with a progress bar, the FileVault prompt, then the login progress. I removed one frame by hand: a logout frame still showing the Dock, with an unread badge. The sitter read it as `prompt_like` because it has no menu bar ([timeline.json](proof/timeline.json) marks it). Fixed in 0.2.1: proof now keeps a non-desktop frame only when it is black, shows a taught screen, or is the Apple logo of a boot the sitter saw. `frame-0023.jpg` has its password field blurred after recording, because the dots give away the password's length.

**After the restart** (from our private notes):
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

Only one was sent that way, by ntfy alone.

### 3b. The same TEST by email (0.2.1, 07:30 UTC)

Ari reads alerts in HEY, not the ntfy app, so 0.2.1 added `notify.email`: ntfy forwards each message as an email. ntfy.sh refuses email from anonymous publishers (400, code 40053), so the sitter posts with the access token of a free ntfy.sh account that has verified the address, sealed on the KVM like the Mac's password.

- 07:30:05: sitter 0.2.1 started, with `notify.email` set and the token sealed (receipt `{"stored": "ntfy", "bound_to": "hardware"}`, no length).
- 07:30:24: `housesitter alert-test mini --again`. The sitter's log: `alert-test: posted 200, emailed <the owner's HEY address>` ([alert-test-email.txt](alert-test-email.txt)).
- 07:30:24: ntfy's own record of the message ([ntfy-record.jsonl](ntfy-record.jsonl), third line).
- 07:30:26: the email, "🏠 TEST: mini is stuck at FileVault", from ntfy@ntfy.sh, at the top of the owner's HEY Imbox, read back with the `hey` CLI ([hey-record.json](hey-record.json); the address is redacted).

The log lines above are 0.2.1's words. From 0.2.2 the ingress line reads `SSH and HTTPS: home, unfiltered (anything that reaches the KVM may connect)`, and a sent email is logged as `emailed`, without the address.

That was the day's first ntfy email; a free ntfy.sh account may send 5 a day, and the sitter keeps to that.
