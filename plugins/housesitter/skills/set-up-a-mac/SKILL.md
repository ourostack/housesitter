---
name: set-up-a-mac
description: Use when the Mac on my cables is wiped, new or part-way set up (Setup Assistant, a login or FileVault screen, a fresh desktop, Company Portal enrollment, the owner's setup command running in Terminal), when the owner says they're moving my cables to another Mac or back, or when I wake mid-setup after a restart of the Mac, the KVM or me.
---

# Set up a Mac

I take a wiped Mac from whatever screen it's on to the owner's reference setup, then hand it to my normal keep-alive duties. The owner does only what a person must: MFA taps on their phone, an Okta Verify or passkey prompt, a screen the sitter won't let me touch, moving my cables. Apart from a few up-front asks, I never block on them: what needs them waits for one sitting at the end (The owner's sitting).

**I start it; the Mac's own agent finishes it.** I'm slow: every click is a full model turn on a 1 GB KVM, and the owner reads five still seconds as death. So I drive only what nothing on the Mac can do yet: Setup Assistant, the accessory Allow and Mirror, enrollment and its compliance items, the password change, Platform SSO, and the kit's first pass. Then I type the owner's finish command in Terminal, which starts an agent on the Mac itself, and take my hands off (step 5). That agent finishes everything else at full speed. From then on I watch, keep the progress window up, and type only what the sitter alone holds.

Every step is check-then-act: I look, decide whether the step is already done, act only if it isn't, and look again to confirm. A rerun, or a restart of the Mac, the KVM or me in the middle, is safe.

## What I need first

**Config:** `setup-a-mac.json` in my state directory (`HOUSESITTER_STATE_DIR`, default `/userdata/ouro/housesitter/`). Its fields are in `setup-a-mac.example.json` beside this skill. If it's missing, I ask Ouroboros once to have the owner write it, and do nothing else.

| Field | What |
| --- | --- |
| `mac`, `reference_mac` | The Mac I'm setting up, and the owner's signed-in Mac where Ouroboros lives. |
| `initial_password` | The Mac's password until enrollment changes it. A throwaway the owner chose and declared non-secret (`initial_password_is_not_secret: true`). Without that flag, I don't type it. |
| `account` | `full_name` and `short_name` for the Mac account. |
| `region` | The country or region Setup Assistant asks for. |
| `enroll` | Optional Microsoft work enrollment: `work_email`, and `install_command`, which installs Company Portal from Terminal. |
| `setup_command` | The owner's one-line setup command. `kit_readme` says what it asks for; `rerun_step` reruns one of its steps; `kit_log` is the log it writes (like `~/Library/Logs/laptop-bootstrap.log`). |
| `reference_dock`, `reference_apps`, `dock_step` | What done looks like: the reference Mac's Dock, in order (app names), and the apps it has in /Applications. `dock_step` is the kit's step that sets the Dock (like `prefs`), rerun with `rerun_step`. |
| `microsoft_password_secret` | Optional, absent by default: the name of a secret sealed on the KVM that is the owner's Microsoft password. Only then do I type a Microsoft password. |
| `finish_command` | The owner's one line that starts the agent which finishes the setup on the Mac itself (like `bash ~/personal-desk/agent-capacity/mac-mini-work-machine-setup/laptop/finish.sh`, which runs the Copilot CLI on the gh sign-in the kit's first pass made, from the owner's brief). The kit's first pass must bring it to the Mac. |
| `operator` | `true` if the owner lets me arm and teach the sitter as their operator (step 6). Otherwise those commands are the owner's. |

**Secrets on the KVM:** only `mac`, the Mac's own login password after enrollment's password change. It is never a Microsoft password: the owner's Microsoft password may differ, and they may sign in with a passkey. Nothing else is sealed here unless the config names it; sealing needs root. I never take a password over the peer link. One-time codes (an Apple two-factor code) are fine.

**This skill ends with the Mac's password set to `mac`.** With `enroll`, step 3's password change sets it. Without `enroll`, nothing does, so step 6 is the owner's.

**My notes:** `setup-a-mac-notes.txt` in the same folder, kept with my own file tools. One line, with its time, per finished step, per message I sent, per step left to the owner, and which password the Mac has now (`initial`, `mac` or `unknown`; see the rule below). Plus the time the cables moved. I reread it on every wake. What the screen shows beats what the notes say.

## Rules

- **Passwords go only through `sitter_type_secret`.** The one exception is `initial_password`, which I type with `sitter_type` wherever the Mac asks for its own password before enrollment has changed it. I never know `mac`'s value, and I never type it any other way.
- **`mac` goes only to the Mac's own prompts:** sudo after the change, the new value in enrollment's password change, a macOS password dialog, FileVault and lock screens. Never a sign-in page (Microsoft, GitHub, Okta, Apple or any other site): those are the owner's.
- **Microsoft sign-ins get no typed password or secret by default.** That covers Company Portal, Platform SSO registration, and the first runs of Teams, Outlook and OneDrive. At a password page I choose "Sign in another way", then the passkey or QR option ("Face, fingerprint, PIN or security key", "Use a passkey"). Then I send the owner one ping with what's on screen (`sitter_notify` with `screenshot: true`: the QR code, or the number to match). Only if the config names `microsoft_password_secret` do I type that secret with `sitter_type_secret` instead.
- **Look before I type or press a key.** I take a fresh `sitter_screenshot` (1280 wide), open its saved picture (`image.path`), and confirm three things: the prompt's words are the ones I expect, the field I mean is focused (a blinking caret or a blue focus ring; in Terminal, the cursor right after the prompt on the last line), and nothing sits on top of it. The KVM can't read keyboard focus; only the picture tells me.
- **`sitter_type_secret` takes `seen`.** That's the frame id from the `sitter_screenshot` or `sitter_look` I just judged. The sitter refuses if that frame is over 30 s old or the screen no longer matches it. If it refuses, I look again; I never retry blind. At the lock screen or any prompt over a moving background, I add `region`, my box around the prompt in the screenshot's pixels, so only the prompt has to stay still.
- **Never an empty Return at a `Password:` prompt, and never a key a prompt didn't ask for.** An empty Return at sudo counts as a failed try (setup lesson m2).
- **Which password the Mac has.** Until enrollment's password change has succeeded, the Mac's login password is `initial_password`, whatever screen I start on (Setup Assistant, a login window, a desktop someone else reached). I type it with `sitter_type`. It's `mac` only once my notes record that change succeeding (step 3, item 7). No notes, or notes that don't record the change, mean `initial`. Notes say `unknown` only after a change that failed halfway; then I try `initial_password` first.
- **A rejected password.** If `initial_password` is rejected, I try `mac` once (with `sitter_type_secret`), and if that works, I note `password: mac`. If `mac` is rejected after my notes say `mac`, or both have been rejected, I stop at once and tell the owner. sudo gives three tries, and failures can lock the account.
- **One password prompt at a time (m7).** Before I open Terminal or start anything that asks for a password, I check whether a prompt is already waiting, and answer that one.
- **Never press Escape at a login window.** It switches to the list of users, where no field has focus.
- **Never use the clipboard.** No cmd+c or cmd+v. I type with `sitter_type`.
- **Setup mode, and the hands gate.** As soon as the cables are on the Mac I'm setting up, I call `sitter_setup_mode` with `on: true`, `mac: <its label>` (6 hours by default, at most 24), and `off` at the hand-over (step 6), before the sitter's armed try. If `sitter_status` shows it off, or ending before I'll be done, while I'm still setting up, I turn it on again. While it's on, `sitter_click`, `sitter_type`, `sitter_key`, `sitter_scroll` and `sitter_type_secret` work on any screen (Setup Assistant, a login window, FileVault), Escape only on a desktop, and the sitter does nothing by itself: no unlock, power or typing at the reference Mac's lessons. Without it, they work only on a desktop with its menu bar, and the sitter refuses anywhere else ("not a desktop with its menu bar", "at a password screen"). I don't work around a refusal; it's a stuck step.
- **Budgets.** `sitter_type_secret` allows 20 an hour. Peer messages: no cap of our own; each goes out at once, and only GitHub's rate limit can make one wait.
- **Poll while anything runs.** Until the hand-off (step 5), while a command, an install, a sign-in or a restart is under way, I take a `sitter_look` every 10-15 s. I answer at once any prompt that's mine: sudo's `Password:`, a macOS password or authentication sheet, an "Allow" for the kit's own tools. I never wait for a peer message or for the owner to notice a prompt.
- **Clear what's in the way (m8, m11).** Until the hand-off, before each step I close notices, first-run windows and banners over the app I'm about to use. Once the step is done, I close every window it opened.
- **A tidy desktop.** Until the hand-off, after each numbered step, I clear every notification and banner, after reading them (the next rule): with each one's X, Notification Center's Clear All, or a wipe. I close finished windows as I go. On the desktop stay only the progress window and the active Terminal work window.
- **Read notifications before clearing them.** Wiping them is fine, and the owner asked for it, but first I read every one, in Notification Center and on the banner stack. I act on any that's an action item before anything is cleared, above all Platform SSO's "Registration Required", which Company Portal's status points to. Only then do I clear or wipe the rest. If "Registration Required" was lost anyway, the recovery is in step 3, item 7 (restart AppSSOAgent).
- **The only sign-ins I need: Company Portal enrollment, Platform SSO registration and the kit's first GitHub sign-in.** Sign-in windows that apps pushed by Intune open by themselves (Global Secure Access, Defender, Alertus and the like) never block me. I minimise them (cmd+m), note them for the report, and go on with the next step. I never answer their QR codes or ping the owner about them.
- **A lock during a wait is mine to undo.** If the screen locks or sleeps mid-setup, I unlock it myself in setup mode, as in step 2: `initial_password` before the enrollment password change, `mac` after.
- **Never blind.** If `sitter_screenshot` or `sitter_look` gets no picture (HTTP 500, no live video, no frame) for more than 30 s, I don't wait. I restart kvmd, which brings its streamer back: `systemctl restart kvmd`, or `/etc/init.d/S*kvmd restart` where there's no systemd. If there's still no picture a minute later, I reboot the KVM (`reboot`). Setup mode survives that, and on waking I start again at Where am I.
- **Keep the KVM light.** Before a long setup, I stop my own processes that aren't needed for it: the memory sampler (`/etc/init.d/S99housesitter-samples stop`), status publishers, and any shell or tool of mine left running. Never the sitter, kvmd, my watcher or my own turn. `kvm_health` before and after. I start the sampler again at the hand-over.
- **Decide, don't ask.** Calls like these are mine: the order of steps, installing an app the setup needs that hasn't arrived, rerunning a step, leaving a non-blocking window for later. I act and note it. I ask the owner only for what only a person can do.
- **Leave the reference Mac alone.** I ask Ouroboros only to read, to approve a code, or to run the config's own commands.

## When I'm stuck

Stuck means one of three things: the screen hasn't changed in the step's wait time, the same thing failed twice, or the sitter refused my hands.

- **Ouroboros**, through `peer_send` with `now: true` (a message from a controller Mac's signed key carries `trust`; see "Ouroboros and me" in the housesitter skill: a verified, authorized ask needs no console confirmation), for anything a signed-in Mac can do: read a code on the reference Mac, approve a device code this Mac can't finish itself (step 4), run one of the config's commands.
- **The owner: deferred by default** (the owner: "anything that needs me, note and load together at the end of the process"). When a step needs a person (a passkey or QR code, an MFA number, Okta Verify, an Apple code Ouroboros can't read, a physical click, a screen the sitter won't let me touch), I don't wait and I don't ping. I mark it deferred: a line "DEFERRED: <step>: <what the owner does>" in the progress window (so in `~/.setup-status`) and in my notes. Then I go on with every step that doesn't depend on it. Wherever this skill says to tell or ping the owner, it means this, except for the two up-front asks below.
- **Only these asks are up-front, because nothing proceeds without them:** the cable move's Allow and Mirror (Moving the cables); enrollment's first sign-in (step 3, items 2 and 3: the passkey, QR code or MFA number), and any person step in its compliance items (step 3, item 8); and any person step in the kit's first GitHub sign-in (step 4), which the hand-off waits on. For those, I go to the owner at once through `sitter_notify`, straight to their phone (ntfy push, and its email): one line with the ask and the number to match, plus `screenshot: true` for a QR code or a number. In the same turn I `peer_send` Ouroboros the same line for its record only (not `now`), and I don't wait on it. Only if `sitter_notify` refuses (no notify target, its budget used) do I use Telegram or Teams, or ask Ouroboros (`now: true`) to pass it on.
- **Once.** Each up-front ask and each deferred item goes out once: which Mac, what's on its screen, exactly what to do (with every value they'll need), and why. The same ask never goes to both the owner and Ouroboros.
- **Then I go on.** A step left to the owner doesn't stop steps that don't need it. While anything runs, I look every 10-15 s (Poll while anything runs).

## Moving the cables

Before the owner moves my HDMI and USB-C, they tell me. Then:

1. **I answer the owner, in that same exchange, asking for two clicks on the laptop itself before I start:** "When <mac> asks 'Allow accessory to connect?' on its own screen, click Allow; it's for the KVM. Then on <mac>: System Settings > Displays > GLKVM > 'Mirror for Built-in Display' (or Cmd+F1 on the laptop's own keyboard). Without mirroring, the KVM gets an empty extended display and I can't see what I'm doing. macOS remembers it for that display, so later runs won't need it." These are the only physical steps after the cables. I can't do them: the prompt shows only on the built-in screen, and the KVM's keyboard sends a plain F1, not the laptop's brightness-down key the mirroring shortcut needs.
2. I `peer_send` Ouroboros (`now: true`): while I'm away, the reference Mac is unwatched. Nobody unlocks it after a restart, so it shouldn't restart until I'm back. I note the time.
3. **Setup mode on** (the rule above). The sitter knows one Mac at a time, so its password and the reference Mac's taught screens would otherwise apply to the new Mac; setup mode stops it acting by itself.
4. After the move, `sitter_look` must show a different Mac: a Setup Assistant pane, a new login window, a new wallpaper. If it doesn't, I stop and tell the owner.
5. **No visible effect means an extended display.** If a laptop shows a desktop with only wallpaper (often dimmed), a menu bar and no windows, and one key or click changes nothing on the picture, my input is landing on the built-in screen, which I can't see (the mouse maps to the main display). I don't try more keys. I tell the owner once: "<mac> isn't mirrored yet: System Settings > Displays > GLKVM > 'Mirror for Built-in Display', or close the lid with power connected." I never change the displays myself; a person at the Mac does (docs/hardware.md).
6. When the cables go back, setup mode is already off (step 6). I look and confirm it's the reference Mac, and that `sitter_status` shows setup mode off and the password verified. If the password isn't verified, I arm and teach it as in step 6 at the reference Mac's next restart, or ask the owner to. Then I tell Ouroboros its watch has resumed.

## Visible progress

The owner reads a still screen as stuck. So from the first desktop until the hand-over, the Mac shows a small window that changes by itself every 2 seconds, and the screen never sits still for more than 10 seconds. Before the first desktop (Setup Assistant, a login window), each pane I answer moves the screen.

1. **Open it once**, as soon as my input works on a desktop. Terminal (cmd+space, "Terminal", Return), then cmd+n for a fresh window, then `sitter_type` this one line (with `kit_log` from the config) and Return:

   ```sh
   caffeinate -dimsu & printf '\e]0;Setup progress\a\e[3;0;30t\e[8;16;90t'; touch ~/.setup-status; while :; do clear; date '+%H:%M:%S  Setup progress'; tail -n 8 ~/.setup-status; echo; tail -n 6 <kit_log> 2>/dev/null; if read -t 2 l; then echo "[$(date +%H:%M)] $l" >> ~/.setup-status; fi; done
   ```

   It first starts `caffeinate -dimsu` in the background, so the Mac doesn't lock, sleep or dim during setup. Then it titles the window "Setup progress" and moves it to the top-left corner. Every 2 s it redraws the clock, the last lines of `~/.setup-status`, and the last lines of the kit's log. A line typed into it, followed by Return, is added to `~/.setup-status` with the time.
2. **A line at every step start and every wait,** until the hand-off (then the finishing agent writes them). I click the progress window, `sitter_type` "<doing now>, <waiting for>" and Return, then click back into the window I was working in. Example: "Enrollment: waiting for the owner's MFA tap, number 47". Never a password or a code.
3. **One progress window, and never my commands in it.** If a "Setup progress" window is already on screen (after a restart of me), I use it. My commands go only into a work window opened with cmd+n. Before typing a command or a password, a fresh look confirms the front window isn't "Setup progress".
4. **Closed at the hand-over** (step 6), as I close everything I open. I click it, press ctrl+c, `sitter_type` `kill %1; rm ~/.setup-status` and Return (that stops `caffeinate`), then cmd+w.

## Where am I?

On every wake I call `sitter_status`, `sitter_look` and `peer_inbox`, and reread my notes. My step is the first one below whose "done when" isn't true and that isn't noted as left to the owner.

## 1. Setup Assistant

**I see:** a large centred pane with a heading, Back and Continue at the bottom, no menu bar.

**With setup mode on, I click through it myself**, with the choices from the table below. Without it, the sitter refuses my hands here: there's no menu bar, and after the cable move a boot is pending. I probe once with `sitter_key` "shift", which changes nothing on any pane. If it's refused, I tell the owner once: "<mac> is in Setup Assistant at '<heading>'; the sitter won't let me click there. Please finish it." The message includes the choices from the table below, with the values filled in: the full name, the account name, and the password `initial_password` (I write it out; it's non-secret by the owner's choice). Then I wait for a desktop or a login window.

With my hands working, I answer each pane by its heading, one at a time, looking after each click:

| Heading | Choice |
| --- | --- |
| Language, Select Your Country or Region | `region`, Continue. |
| Accessibility, Data & Privacy | Not Now; Continue. |
| Wi-Fi network, How Do You Connect? | Ethernet if offered. A Wi-Fi password isn't mine to type: if Wi-Fi is the only way, that's stuck. |
| Transfer Your Information, Migration Assistant | Not Now, or Set up as new. |
| Sign In with Your Apple Account | Set Up Later, then Skip. It goes to the owner's sitting (step 7). |
| Terms and Conditions | Agree, then Agree in the sheet. |
| Create a Mac Account | Full name `full_name`. Account name `short_name` (cmd+a first if it differs). Password and Verify: `initial_password` with `sitter_type`, a fresh look before each field. Hint empty. Continue. |
| Enable Location Services, Select Your Time Zone | Continue with what's shown. |
| Analytics | Untick both "Share" boxes, Continue. |
| Screen Time | Set Up Later. |
| Siri | Untick "Enable Ask Siri", Continue. |
| FileVault Disk Encryption | Not Now, if it's offered: with `enroll`, enrollment turns FileVault on and escrows its key. If it can only be turned on here, it's the owner's: every look returns the picture to me, so a recovery key on screen would enter my context. I tell the owner once to turn FileVault on here and keep the key themselves, and I don't look again for 2 minutes. |
| Touch ID, Apple Pay | Set Up Later. |
| Choose Your Look, Update Mac Automatically, Welcome to Mac | Continue. |
| Anything else | The skip choice (Not Now, Set Up Later, Skip) if there is one, else Continue. I note the heading. |

**Done when:** a desktop with a menu bar, or a login window. I note `password: initial`.

## 2. Login, lock or FileVault screen

**I see:** an avatar, the owner's name and an "Enter Password" field, with no menu bar.

In setup mode I type here myself, after a fresh look shows the password field focused (if the list of users shows instead, I click the owner's tile and look again):

- **Notes say `initial`, `unknown`, or don't record the change:** `sitter_type` `initial_password`, then `sitter_key` "return".
- **Notes say `mac`:** `sitter_type_secret` `mac`, prompt "<login/FileVault> password field on <mac>", `enter: true`, `seen`.
- **Outside setup mode, notes say `initial`:** the sitter refuses `sitter_type` at a password screen. Stuck. I tell the owner once: "<mac> is at its <login/FileVault> screen. Its password is still the setup password, `<initial_password>`, and the sitter won't type it there. Please log in once."
- **Outside setup mode, notes say `mac`:** `sitter_unlock`. If it refuses because this screen hasn't been taught, or the password is on hold: at FileVault I do step 6's items 1 and 3 now, if `operator` is set and the sitter saw this boot less than 15 minutes ago (`learn-prompt --filevault` is refused after that). Otherwise, or at a login or lock screen, I'm stuck.
- I never press Escape here, and I never wake the screen with keys; the sitter does that itself.

**Done when:** a desktop with a menu bar.

## 3. Work enrollment (only if `enroll` is set)

**Done when, first and above all:** Company Portal > Devices > this Mac > Check status reports no action items, and access is allowed. "MDM enrollment: Yes" is not done: a Mac with action items left never becomes compliant, and loses its enrollment (2026-11-20). Nothing after this step starts until Check status is clean.

**Also:** in Terminal, `profiles status -type enrollment` reads "MDM enrollment: Yes", my notes say `password: mac`, and `app-sso platform -s` shows `"registrationCompleted" : true`. Platform SSO comes before step 4: it makes Microsoft sign-in work in every browser on the Mac without a passkey, which every later device code depends on.

1. **Install Company Portal** if Spotlight (cmd+space, "Company Portal") doesn't find it. In a Terminal work window (cmd+space, "Terminal", Return, then cmd+n), `sitter_type` `enroll.install_command`, Return. At `Password:`, `sitter_type` `initial_password`, Return. Done when the command ends without an error.
2. **Sign in.** Company Portal, Sign In. Email field focused: `sitter_type` `work_email`, Return. At Microsoft's "Enter password" page, I take the passkey route from the rule above: "Sign in another way", then the passkey or QR option, and one ping to the owner with what's on screen. With `microsoft_password_secret` set, I type that secret instead, after a fresh look, with `enter: true` and `seen`.
3. **The passkey or MFA.** After the passkey ping, I look every 10-15 s for up to 5 minutes. If the QR code expires, I start the passkey option again once and ping once more; after that, stuck. At "Approve sign in request", with a number if number matching is on, I tell the owner once: "On your phone: approve the Microsoft sign-in for <mac> (enrolling it), number <n>." I look every 10-15 s for up to 5 minutes. On "We didn't hear from you" or "Request denied", I press "Send another request" once and tell the owner once more, with the new number. After that, stuck. At "Stay signed in?": Yes.
4. **Device management profile.** Begin; Continue through "Review privacy"; Download profile. System Settings opens at Device Management: Install, then Install. At "Enter your password to allow this": `sitter_type` `initial_password`, Return.
5. **Back in Company Portal**, "Checking device settings" should end at "You're all set". If it names a setting to fix (FileVault, an update), I fix it and recheck.
6. **The password change** (old is `initial_password`, new is `mac`). In a dialog on the desktop:
   - Old field focused: `sitter_type` `initial_password`.
   - Tab, fresh look, New field focused: `sitter_type_secret` `mac`, prompt "new password in the macOS password change dialog".
   - Tab, fresh look, Verify field focused: the same, with `enter: true`.

   If the change is asked at the login window instead, I do the same there in setup mode: the old password, then the new one twice, with a fresh look before each field. Outside setup mode, that's a password screen: stuck.

I note `password: mac` the moment the change succeeds. If it fails halfway, I note `password: unknown` and tell the owner once.

7. **Platform SSO registration, right after the change and before step 4.** It arrives when Intune delivers its profile, as a "Registration Required" notification; I don't wait idly for it. If it isn't there, I look for it in System Settings > Users & Groups and Company Portal, and check `app-sso platform -s` in a work window every 10-15 s. If "Registration Required" is missing although `app-sso platform -s` shows the extension configured but not registered, I restart the agent that posts it: `killall AppSSOAgent` in a work window (macOS starts it again, and it posts the notification again). When it's there: click it, then Register. A Microsoft sign-in follows (items 2 and 3 again). At "enter your Mac password", the password the Mac has now (the rule above; `mac` after the change).

8. **Compliance, before anything else.** Company Portal > Devices > this Mac > Check status. I copy its action-items message word for word into my notes and the progress window. Then I do each item, for example:
   - register the Mac with the work account, through "Registration required" or Edge's "Set up your device to get access";
   - update macOS to the version it names (Software Update, and the restart: I unlock in setup mode);
   - turn on what it names (FileVault, a firewall).

   Then Check status again. I repeat until it reports no action items and access allowed. An item that needs a person is an up-front ask: nothing proceeds without it.

## 4. The kit's first pass

**Done when:** the kit's first pass has brought `finish_command`'s script to the Mac (`ls` of it in a second work window finds it). The kit goes on in its own window; from the hand-off, that's the finishing agent's.

1. **Terminal.** If a Terminal work window already shows the kit's output, I use it and open no other. Otherwise cmd+space, "Terminal", Return, then cmd+n for a work window.
2. `sitter_type` `setup_command`, Return.
3. I look every 10-15 s and act at once on what's at the bottom:

| The output shows | I do |
| --- | --- |
| `Password:` (sudo) | Notes say `mac`: fresh look, then `sitter_type_secret` `mac`, prompt "sudo Password: in Terminal running the setup command", `enter: true`, `seen`. Otherwise (`initial`, `unknown`, or no record of the change): `sitter_type` `initial_password`, then Return. |
| `Sorry, try again.` | As in the rule on rejected passwords. If I stop, sudo's prompt times out and the kit stops; once the owner has fixed it, I run `setup_command` again. |
| `! First copy your one-time code: XXXX-XXXX`, then `Open this URL to continue in your web browser: https://<host>/login/device` (gh) | I read the code, the host and the account (from the kit's line just above) off the screen, and start on it at once (Device codes, below). |
| `To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code …` (az) | The same: Device codes, below. If Conditional Access still refuses ("device must be managed", AADSTS53000), the kit marks the step "needs a person"; I tell the owner once through `sitter_notify` and let the kit go on. |
| A sign-in window on this Mac (and Teams, Outlook or OneDrive on first run) | Microsoft "Pick an account": the work account. A Microsoft "Enter password" page: the passkey route, as in the rule on Microsoft sign-ins. Any other site's password page: the owner's. MFA: as in step 3. |
| A `(Y/n)` or `[y/N]` question | What `kit_readme` says. If it says nothing, Return for the default, and I note it. |
| A macOS prompt raised by the kit's own tools (node, Terminal, ouro: "would like to access", "App Background Activity") | Allow. Anything asking for a password, admin rights or a security override, or coming from another app, I leave and report. |
| `STOP:`, or the command ends with an error | I note the reason and tell the owner once. When it's fixed, I run it again; the kit is safe to rerun. |
| Nothing new for 20 minutes | I tell Ouroboros what's on screen and ask what it reads as. If neither of us can tell, I tell the owner. |

**Device codes** (until the hand-off; after it, the finish brief's). A code lives about 15 minutes, so none is ever left waiting.

- **Sign-ins that go through the owner's Microsoft account are mine to finish on this Mac.** That covers a GitHub EMU account on github.com (its login ends in a suffix like `_microsoft`), a GitHub Enterprise host (`*.ghe.com`, like microsoft.ghe.com) and `az login`.
  1. In a second work window (cmd+n), `sitter_type` `open -a "Microsoft Edge" <the device URL>` and Return. If that fails because Edge hasn't arrived from Intune yet, I run `brew install --cask microsoft-edge` there myself, without waiting, then open the URL again.
  2. I type the code and press Continue.
  3. I go on through Microsoft's sign-in, where the enrolled Mac is already signed in: I pick the work account, and any password page takes the passkey route.
  4. Then Authorize (or Continue at "Are you trying to sign in to …?").
  5. The kit's window says it's done; I close the browser tab and the second window.
  Only a passkey, QR code or number match goes to the owner, straight through `sitter_notify` with a screenshot, never through a peer relay.
- **Any other account** (a personal GitHub account): Ouroboros approves it in its signed-in browser (`peer_send`, `now: true`). If it reports Okta Verify, FastPass or a passkey, that goes to the owner through `sitter_notify`.
- **Expired** (gh: "expired", `expired_token`; az: AADSTS70020 or "code expired"; the device page says the code is invalid): I rerun that step at once with `rerun_step` for a fresh code, and start on the new one.

## 5. Hand off to the finishing agent

**Done when:** my notes say "handed off". After a wake I start `finish_command` again only if its window shows it ended without its report.

1. **Stop the kit's first pass**, so only one kit runs: in its Terminal window, at a moment it isn't at a password prompt, ctrl+c. Its steps are safe to rerun, and the finishing agent reruns them.
2. In that window, `sitter_type` `finish_command` and Return, then I note "handed off". Its first sudo asks for the Mac's password once: I type it (`sitter_type_secret` `mac`, with `seen`). No Copilot app sign-in is needed: it runs on the gh sign-in the kit's first pass made.
3. I tell the finishing agent nothing more; the owner's brief says what to do, and that its done check starts with Company Portal > Devices > this Mac > Check status showing no action items. If the brief doesn't say so, I add that to my notes for the owner's report.
4. **Hands off.** From here the finishing agent drives. The finish brief covers:
   - the kit's remaining steps and their device codes (Microsoft-backed ones finished in the Mac's own browser);
   - the apps Intune assigned but hasn't pushed (Company Portal > Apps);
   - making the Dock and /Applications match `reference_dock` and `reference_apps`, as far as it can without the owner;
   - the kit's done check;
   - a list in `~/.setup-status` of what needs the owner.

**After the hand-off, I only watch:**

- A look every 10-15 s. The progress window stays up, and the finishing agent adds its lines to `~/.setup-status`.
- **The only things I still type:**
  - a password prompt only the sitter can answer (sudo, a macOS password sheet), with `sitter_type_secret` as before;
  - an unlock if the screen locks.
- If the screen stays still for a minute with no line in `~/.setup-status` saying why, I read the last lines of the finish window. If it's at a prompt that's mine (a password), I answer it. If it has ended without its report, I run `finish_command` again in the same window.
- **Finished** when Company Portal's Check status for this Mac still shows no action items, and access allowed (the first item of every done check; I look at it myself), and `~/.setup-status` holds the finishing agent's report, with its done check passing except for the items it lists for the owner. Then step 6, then step 7 if anything is listed.

## 6. Hand over to keep-alive

**Done when:** my notes record that this Mac's FileVault screen was taught and the sitter's try reached the desktop.

First, **check that mirroring stuck**, so any later recovery (FileVault, a login window) shows on the KVM's picture. In System Settings > Displays, GLKVM must read "Mirror for Built-in Display". If it doesn't, I tell the owner once, as in Moving the cables, and go on.

Then I close the progress window, which stops `caffeinate` (Visible progress, item 4). I start the KVM's memory sampler again (`/etc/init.d/S99housesitter-samples start`).

Then setup mode off (`sitter_setup_mode` with `on: false`): from here the sitter keeps this Mac alive, and its armed try below types only with setup mode off.

Teaching needs `operator: true`. Without it, I ask the owner to run `housesitter unlock <reference_mac> --trial`, restart the Mac, and at FileVault run `housesitter learn-prompt <reference_mac> --i-see-the-field --filevault`. Their housesitter config knows the KVM by the reference Mac's name. Then I watch.

1. I arm one supervised try: `<sitter> password-trial`. `<sitter>` is `HOUSESITTER_SITTER_CMD`, by default `python3 /etc/kvmd/user/housesitter/sitter.py`.
2. I restart the Mac: Apple menu › Restart…, then Restart.
3. If the KVM's picture stays dark for 2 minutes after the boot while the Mac is on, FileVault is drawing only on the built-in screen. I tell the owner once: "Close <mac>'s lid with power connected, so the KVM's display is its only one." When `sitter_look` shows the FileVault password field, within 15 minutes of the boot, I run `<sitter> learn-prompt --filevault taught by Housesitter during setup, field seen on the KVM`.
4. The sitter types its one armed try by itself. If the desktop follows, the password is verified. If not, it goes back to unverified, for the reference Mac too, and I tell the owner once.
5. **I report** to the owner and Ouroboros. I never call it done while the Dock or /Applications differs from the reference; until the owner's sitting is over, I name each difference instead. The report says what's set up, what's deferred for the owner, how many times I needed them, and the time from the cable move to here. If anything is deferred, step 7 follows. Otherwise, from now on my usual skill applies.

## 7. The owner's sitting

**Done when:** Company Portal's Check status for this Mac shows no action items, no deferred item is left in my notes, and the Dock and /Applications match the reference.

1. **One list, once.** When everything that doesn't need the owner is done, I send one `sitter_notify` with the deferred items in the order they'll come up: mine, and the finishing agent's in `~/.setup-status` (its `DEFERRED:` lines, or a section for the owner). Each says what the owner does ("Okta Verify: approve GitHub on your phone", "passkey for az login"). The full list also goes in the progress window, if it's still open, and to Ouroboros for its record.
2. **When the owner says they're ready** (on any channel I hear), the prompts go up one after another, so they're all done in one sitting. I bring each up: rerunning its step in a work window (with `rerun_step` for a fresh device code) and bringing its window to the front. I tell the owner in one line what's on screen, type only passwords the sitter holds, and look every 10-15 s until it's done. Then I note it done and move to the next.
3. **Then the reference check.** Once the sitting is over (the Apple Account signed in, so App Store apps can arrive), I run `finish_command` again, so the finishing agent reruns its Dock and /Applications check against `reference_dock` and `reference_apps` and fixes what differs. I call the setup done only when they match.
4. Anything still open after that goes in my report as the owner's, with what it needs.

## Contribute back

A lesson about driving Macs in general (focus, prompts, notifications, displays) goes back where every agent gets it, not only into this skill. I tell Ouroboros, which opens a pull request to ourostack/hackamore (the engine that drives any Mac app) and to ourostack/ouro-ui's Ouro AX guidance. This skill keeps what's specific to setting up a Mac from the KVM.
