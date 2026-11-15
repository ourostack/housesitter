# 15 November 2026: the app froze twice, crashed once, and the Mac rebooted for an update

What happened on our Mac mini between 09:18 and 12:06 PT, what the logs show, and what is not knowable. Written
the same day, from the Mac's own logs. Times are PT.

## Sequence

| Time | What | Evidence |
| --- | --- | --- |
| 09:18 | The Copilot app (1.4.2) starts, process 77173. | the crash report's launch time; the keeper's log |
| before 11:36 | The app's window freezes. Nothing of ours noticed. A person restarted it by hand. | the person, afterwards |
| 11:36:01 | The app aborts: an uncaught Objective-C exception on its main thread, inside `-[NSWindow setStyleMask:]` (AppKit's `NSPerformVisuallyAtomicChange`), called from a block on the main dispatch queue. | the `.ips` crash report, SIGABRT, `abort() called` |
| 11:36–11:43 | The keeper resumes 15 of 16 working sessions; the sixteenth failed three tries with `socket_error`. | `housesitter-copilot-resume.log` |
| about 11:40 | The relaunched app freezes again. A person starts the pending macOS update (27.2.1). | the update's install log; the person |
| 11:41:03 | The last once-a-minute run of the KVM watch before the gap. | `housesitter-watch-mini.log` |
| 11:42:03 | launchd, for this user: `pending spawn, domain in on-demand-only mode`. From here it starts no job. | `log show`, process `launchd` |
| 11:54:12 | macOS 27.2.1 is recorded as installed. | `softwareupdate --history` |
| 12:00:54 | The Mac reboots (`kern.boottime`). | `sysctl kern.boottime`, `last reboot` |
| 12:04:43 | The login window checks in; the user session starts. | `lsappinfo` |
| 12:05:44 | The app starts again (process 1856). | `ps` |
| 12:06–12:09 | The keeper resumes all 16 working sessions, the one that failed before included. | `housesitter-copilot-resume.log` |

## Root cause 1: the 11:36 crash

The app's own main thread called `NSWindow setStyleMask:` from a block on the main dispatch queue, and AppKit threw.
The app is a Tauri (Rust) app on WebKit, and a window-style change there is a fullscreen, decorations or resizable
change. It is the app's bug, and a window-style call is not something housesitter makes: the keeper and the restart
job quit through the Quit menu item only, and no restart job ran at 11:36 (the last ran at 09:13).

Two things stand out:

- **The freeze was in the window, not in the app's server.** The app's log shows its WebSocket server answering
  session-liveness probes in the same second as the abort. A probe of the socket alone would have called it healthy.
  Freeze detection has to ask the main thread too.
- **Not knowable from here:** what the person did at that second (a click that changed the window's style, or the
  force-quit of a frozen window). The crash report names no trigger, only the call.

## Root cause 2: the 12:00 reboot and the 25-minute gap

Nothing hung and nothing panicked. There is no kernel panic report, no watchdog reset and no jetsam event before the
reboot. The Mac rebooted because a person started the pending macOS update, and the update restarted it.

The gap in the once-a-minute log (11:41 to 12:06) has two parts. From 11:42 launchd, for this user, was in
on-demand-only mode, which is how macOS prepares a restart for an update, so it started no job, ours included. Then
the Mac was down and logging in until 12:05. Sleep was not the cause: the Mac's sleep setting is already 0 and
`caffeinate` and `powerd` hold assertions.

This is why a launchd job cannot be the only watch: it cannot run while the Mac is getting ready to restart. The
recovery is on the other side. After the reboot launchd starts everything again, the keeper opens the app and
resumes the sessions, and the new watch records the gap and its cause.

## What was missing

- A probe of the app's **main thread**, not only its socket. Added: `restart-copilot --heartbeat`.
- A record of **why a gap happened**, once, after the fact. Added: the stall record in the heartbeat.
- A **second look after a recovery**: did each session take a turn, and stay healthy for hours. Added:
  `restart-copilot --health-watch`.
- **OS updates on our terms**: a quiet time, sessions at a safe point, and everything resumed after the reboot.
  Added: `restart-copilot --os-updates`.

[Design](../../../README.md#what-it-does-when-the-app-freezes-crashes-or-the-mac-restarts)
