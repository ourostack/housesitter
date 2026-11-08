# Security

housesitter types a password into a computer with nobody watching. This is how it keeps that safe, and where its protection ends.

## What it protects

- **The Mac's password** is copied once, from your Keychain, over SSH stdin, to the KVM. There the sitter seals it with a key derived from the KVM's own hardware ids (its eMMC CID and SoC serial) and stores it root-only (0600). It is never in a process's argv, a log, `status.json`, a gist, a notification or a cloud.
- **It is typed only at the prompt.** Where the KVM has working OCR, before each unlock the sitter wakes the screen with a lone Shift (which types nothing) and reads the whole screen with the KVM's own OCR. Where it doesn't (a GL.iNet Comet at 2560x1440), only the boot watch types: within 15 minutes of a real boot (the Mac enumerated the KVM's keyboard again), on a frame with no menu bar that has been steady for 20+ seconds, twice a boot at most. HDMI coming back without a boot never arms it. [docs/hardware.md](hardware.md#the-boot-watch-knowing-the-filevault-screen-without-ocr) has the details. With OCR, it types only if it reads the FileVault or login password prompt and no menu bar or app names. A desktop is a refusal, even when asked: the password would land in the focused app.
- **Budgets.** At most three unlocks an hour across incidents; two failed unlocks in one incident and it stops and tells you.
- **No remote typing of secrets.** No command carries the password. `housesitter unlock` asks the sitter to type its own copy, under the same checks. `type` refuses text that looks like a password or token, because on the outbox route it passes through a gist.
- **Messages say what, never the secret.** A message carries the Mac's name, its state and what to fix. An ntfy topic made by `--notify ntfy` is private only by its random name (like a secret gist), so anyone who learns it can read those messages; use a webhook you control, or your own ntfy server, if that matters.
- **The KVM is pinned.** The client pins the KVM's TLS certificate at `adopt` and refuses a different one.
- **The KVM reaches nothing** on your tailnet (`tag:kvm` with no outbound grants; `housesitter tailnet-policy`), and `adopt` turns GL.iNet's cloud binding off.
- **The outbox token** is gist-only, sealed on the KVM like the password. Requests carry an id, are marked seen before they run (never twice), and are dropped after 10 minutes.

## Where it ends

- **Root on the KVM can read the password.** The seal makes a copied file useless elsewhere (a backup, a support bundle, a pulled card); it does not stop someone who controls the running KVM. Treat the KVM like the Mac's keyboard with the password taped to it: physically and on the network, keep it as private as the Mac.
- **Anyone with the KVM's admin password can drive the Mac's keyboard and see its screen.** That's what a KVM is. Keep it off shared networks and behind your tailnet.
- **The sealing is standard-library crypto** (HMAC-SHA256 in counter mode, encrypt-then-MAC) because a KVM's Python may have no AES module and nothing should need installing on it.
- **Microphones:** the GL-RM1PE has none that we know of. Some KVMs have shipped with one undocumented ([NanoKVM](https://github.com/sipeed/NanoKVM/issues/693)); check yours.
- **Managed Macs:** if your Mac is managed by an organization, check its policy before you put a KVM on it and its password on the KVM.

Found a problem? Open a [security advisory](https://github.com/ourostack/housesitter/security/advisories/new).
