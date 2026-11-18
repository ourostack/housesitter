# Usage: every command and flag

`housesitter --help` lists each command with its summary, and `housesitter help <command>` shows its examples. This page keeps the full usage, with every flag, for each command.

```text
housesitter demo                         the real evening it was built for, replayed (no hardware)
housesitter demo night                   one bad night, rehearsed: a panic, a freeze, a changed password
housesitter adopt <mac> --address <ip>   set up a new KVM next to <mac>: three cables in, then this
    [--notify ntfy|<url>] [--email <you@example.com>] [--watched-by <url>] [--location home|away] [--fingerprint <sha256>]
    [--this-mac] [--outbox] [--dry-run] [--fake]
housesitter secret <mac> <mac-password|kvm-admin|outbox-token|ntfy-token|apple-account>   store a secret (read from stdin, no echo);
                                         apple-account stays on this Mac (never the KVM) and also lets hackamore type it into
                                         Setup Assistant's iCloud password pane and nowhere else
housesitter apple-account <mac> [--now | --watch | --expect-reboot --why "<the 12:00 update reboot>" | --install-agent | --uninstall-agent [--dry-run] | --status]
                                         the Apple Account password prompt after an update reboot: within 30 min of a boot
                                         Housesitter coordinated (--expect-reboot marks one before it), or with --now, it is
                                         typed from the Keychain into that prompt only; a verification code is never typed;
                                         every use is logged (no value) and the agent is told once
housesitter proof <mac> [--record <dir>] record what the KVM sees while you restart the Mac
                                         (desktops are never recorded unless --all-frames)
housesitter plug <mac> find|adopt [ip]|status   the smart plug on the Mac's cord: set it up safely, read it
housesitter plug <mac> prove --attended  one real 10 s power cut, watched until the Mac is back

housesitter doctor <mac> [--private]     everything in one screen: what the KVM sees, the Mac, the budgets
                                         (--private hides the picture, for a screenshot or a screen share)
housesitter look <mac>                   one read-only look at the screen   (--picture <file>: a saved one)
housesitter screenshot <mac> [--out f.jpg] [--max-width 1280]
housesitter click <mac> <x> <y> [--right|--double]    in the last screenshot's pixels
housesitter type <mac> <text>            housesitter key <mac> <combo>     housesitter scroll <mac> <up|down> [n]
housesitter computer <mac> '<json>'      an Anthropic computer-use action, as-is
housesitter unlock|power-cycle|power-on <mac>     ask the sitter (it keeps its own limits and checks)
housesitter unlock <mac> --trial|--hold  arm one supervised try of the stored password, or disarm it
housesitter unlock <mac> --attended-test you are locking and unlocking on purpose: its own budget (30 an hour)
housesitter want-desktop <mac> [--minutes 10]   an agent needs the UI: unlock now, and again if it locks meanwhile
                                         (only with "unlock_lock_screen": "on_request" or true in its config)
housesitter watch-kvm <mac> --install   on the Mac: a LaunchAgent that checks the KVM every minute, and tells you
                                         once if it goes silent (and once when it's back): the Mac watches its KVM
                                         [--silent-min 5] [--test]; also --once, --status, --uninstall
housesitter alert-test <mac> [--again]  one real "I'm stuck" message through the rules, marked TEST (over SSH; once a day)
housesitter learn-prompt <mac> --i-see-the-field --filevault  teach FileVault during a restart
housesitter learn-prompt <mac> --i-see-the-field --regions '<json>'
                                         teach the lock screen's empty field and hint (see Lock lessons below)
housesitter learn-prompt <mac> --i-see-the-field --grid <x> <y>  the login window's list of users: x y is your
                                         account's tile, as fractions of the screen (0.48 0.87)
housesitter power-cycle <mac> --attended  you have looked: skip the frozen-desktop check (never the budgets)

housesitter ls <mac>                     the Mac as state + the actions available now (Ouro Reins)
housesitter do <mac> <action> ['<json>'] run one; refusals: action-unavailable, input-invalid, action-failed
housesitter forget <mac> --yes           wipe the secrets from the KVM and stop the sitter
housesitter peer send <text> [--re <id>] [--now]
                                         Ouroboros to Housesitter, the agent on the KVM: free text through a secret gist,
                                         sent within 6 minutes (--now: at once; 10 gist writes an hour at most)
housesitter peer inbox [--peek]          Housesitter's new messages, oldest first, each shown once (--peek: don't mark them read);
                                         also sends queued messages that are due
housesitter peer flush <mac> [--now]   send the queued messages if due (--now: at once, within the hourly cap)
housesitter peer watch <mac> [--agent ouroboros] [--every 30] [--once] [--ouro <path>]
housesitter peer drill <label> [--minutes 60] | --end   mark a planned drill: the link labels everything sent meanwhile
                                         wake the agent with ouro msg when Housesitter writes (marks nothing read),
                                         and send its queued messages when due; logs to peer-watch.log beside the config
housesitter restart-copilot [--resume] [--dry-run|--detach]   restart the GitHub Copilot app on this Mac and lose no session's work:
                                         ask working sessions to reach a safe point, quit through the app's Quit menu
                                         (hackamore), relaunch, then send each session that was working a resume message
                                         and check it took a turn. --dry-run lists what it would do now; --detach runs it
                                         as a launchd job that survives the app quitting; --status shows the run now or the last
                                         (state, step, start time, result)
housesitter restart-copilot --resume-only [--watch [--open-at-login]] [--dry-run]   resume what an app stop left unfinished
                                         (a crash, an update, a login), restarting nothing; --watch does it for every new app
                                         process; --open-at-login also opens a closed app once per login
housesitter restart-copilot --heartbeat [--dry-run]   one probe of the app with no model turns: its socket and its window (the main
                                         thread, through an accessibility read). Failing for 2 minutes is a freeze: it takes a sample,
                                         quits the app (SIGTERM, then SIGKILL to exact pids), relaunches it, resumes the working
                                         sessions and tells the agent once. A crash report and no app is relaunched the same way;
                                         a gap of 5+ minutes between its own runs is the Mac stopping, recorded with its cause
                                         turns: for each resumed session, did it take a turn, is it erroring, is it stuck busy; asks
                                         again once, and tells the agent by name only about what stays broken; --status shows it
housesitter restart-copilot --os-updates [--now] [--window 2-5] [--dry-run]   one pass for a pending macOS update, which macOS installs itself (no admin rights here):
                                         reads softwareupdate -l, the automatic-update settings and the enforced install deadline; shortly before macOS
                                         acts (the deadline less 90 min, the quiet hours with nobody at the Mac, or the install starting) it gets every
                                         working session to a safe point, arms the Apple Account prompt fill (apple-account --expect-reboot) and holds
                                         until the reboot, then launchd and the resume watcher bring everything back; if the Mac did not restart it
                                         stands down. Automatic install off: tells the agent once which setting a person must turn on. --now runs the
                                         safe point at once and waits 20 min for a person to restart the Mac
    [--listing <file>]                   with --os-updates: read a saved softwareupdate -l (rehearse with --dry-run)
housesitter restart-copilot --install-recovery [--mac <mac>] [--dry-run]   write and load the launchd agents for the above (the heartbeat every 30 s, the OS-update check every 5 min, and the rest) and a
                                         caffeinate that keeps the Mac awake; --mac also installs that Mac's apple-account agent; --uninstall-recovery removes them
housesitter restart-copilot --install-keeper [--dry-run]   write and load the launchd agent (bot.ouro.housesitter.copilot-resume)
                                         that runs --resume-only --watch --open-at-login at login and keeps it running
housesitter restart-copilot --plugin-updates [--dry-run]   one pass: when a plugin the app loaded is older than the
                                         newest release in the app's plugin cache and that release changes a skill, hook, agent or Desk's MCP tool list, run
                                         restart-copilot --resume --detach for it, unless someone is using the Mac, a restart ran in the last
                                         6 h (--cooldown-hours) or is running; logs the decision
housesitter restart-copilot --install-plugin-updates [--dry-run]   write and load the launchd agent (bot.ouro.housesitter.plugin-update-restart)
                                         that runs --plugin-updates every 5 minutes; --uninstall-plugin-updates removes it
    [--why "a Desk runtime upgrade"] [--also <session id>]... [--skip <session id>]... [--sigterm] [--hackamore "<command>"] [--app "<name>"]
    [--settle 600] [--settle-max 10800] [--grace 25] [--person-wait 600] [--copilot-home <dir>]
housesitter deploy housesitter|shepherd [--ref <tag|branch|sha>] [--clone <dir>] [--dry-run] [--json] --why "<who asked, and what they said>"
                                         build and check the newest v* tag (or --ref) as a release folder, then point current at it
                                         in one rename; jobs that ran the clone are rewritten to current and reloaded, and the three
                                         newest releases are kept. Never git pull in a live clone (README: Updating)
housesitter steer [--repair] [--list] [--no-sessions] [--peer <device name>] [--install|--uninstall]   can another computer see and drive this Mac's
                                         agent sessions through Agency Hub? The daemon connected, tracking every session and under launchd; this Mac's
                                         device and live sessions readable in Hub's service; whether new sessions start with Remote control on.
                                         --repair puts the daemon back under launchd with track-all; --list shows the sessions as Hub reads them;
                                         --peer says whether this Mac can read another Mac's device (the laptop's view of the mini);
                                         --install loads bot.ouro.housesitter.steer (every 2 min, no model turns); exit 1 when something is wrong
housesitter hold [--dry-run] [--json] [--quiet] [--why "<reason>"]   keep the launchd jobs listed under launchd_disabled in config off: disable each again if it came back on, and stop it if it is running (by PID); --quiet prints only what it changed; bot.ouro.housesitter.hold runs it hourly (installed by --install-recovery); exit 1 when a job cannot be stopped
housesitter laptop-arrival <mac> [--config <file>] [--dry-run] [--status] [--install|--uninstall]   when a Mac that was away is back online, bring it up to
                                         date and tell the agent once: update and restart its Copilot app (sessions saved and resumed), unload the jobs
                                         this Mac took over, verify its Hub daemon; every step checks first, so a second run changes nothing
housesitter fleet [--stale-min 15] [--disk-floor-gb 20] [--always-on <mac>,<mac>] [--from <gist.json>]   every Mac side by side from the fleet
housesitter fleet run <host> <step> [--wait <s>] --why "<reason>"   ask another Mac, through the fleet gist, to run one step on its allowlist (`caretakers.fleet_run` in its config); it runs once, expires after a day, and posts its exit code and last lines back
housesitter fleet run --status [--id <id>]   the requests and what became of each; exit 1 when one failed, timed out, was refused or expired
housesitter fleet run --serve [--quiet]   one serving pass on this Mac: run what is asked of it and allowed (bot.ouro.housesitter.fleet-run runs it every minute; installed by --install-recovery)
                                         gist's health records: how old each is and what is wrong (exit 1 when anything is);
                                         HOUSESITTER_FLEET_GIST and HOUSESITTER_FLEET_USER choose the gist and the gh account
housesitter tailnet-policy               a Tailscale policy where the KVM reaches nothing
housesitter doctor                       check this computer's setup (status <mac> is doctor <mac>)
```

## Lock lessons

Lock lessons now use two marked widgets, not a screen-wide collection of bright pixels. On the KVM's own picture, show the **empty password field** and its **hint text** (for example, “Touch ID or Enter Password”). An avatar or wallpaper alone is not enough. Mark each widget with `[left, top, right, bottom]` as fractions of the whole HDMI picture. Keep the field rectangle on its border and the hint rectangle tight around its text; exclude surrounding wallpaper. The hint may be inside the field, but its rectangle must leave room for the field's border.

```sh
# Synthetic coordinates, NOT a lesson for your Mac: measure its own KVM picture.
housesitter learn-prompt studio --i-see-the-field \
  --regions '{"field":[0.43,0.85,0.57,0.8933],"hint":[0.42,0.907,0.58,0.927]}'
```

The sitter takes three frames. It learns signed local contrast within each marked widget and requires both widgets to match at least 90%, at one common offset. It searches up to 1.2% of screen width and 4.56% of screen height in either direction. Reference pixel centres scale with the picture's resolution; the search uses native HDMI pixels, so a one-pixel movement does not disappear between coarse samples. It does not lower the threshold or search for the field and hint independently. Missing widgets, changed relative layout and an unknown screen still refuse typing. A larger redesign needs another trusted lesson.

Existing FileVault, user-list and lock lessons remain readable. Once a new widget-based lock lesson exists, the sitter ignores old lock lessons, so an avatar-only match cannot bypass the field and hint. An upgrade alone cannot recover features an old lesson never stored: teach the new lesson on the KVM before relying on wallpaper tolerance. The watch-only SSH key remains limited to `watch_check` and `status`; use an already-authorized operator connection or run `sitter.py learn-prompt --regions '<json>'` locally on the KVM. Do not widen the watch key.

Tests use synthetic fields and text over two unrelated wallpapers, joint movement and a doubled resolution; they check missing widgets, independent movement, noisy/bright pictures, a desktop, password trust and lock policy. These tests are not a live-device unlock or a replay of the November 17 incident.

Add `--json` to any command for machine output. `version --json` returns `{"version":"..."}` and `tailnet-policy --json` returns `{"policy":"..."}`, with the full policy text. The config file is `~/.config/housesitter/config.json`, or `$HOUSESITTER_CONFIG`.
