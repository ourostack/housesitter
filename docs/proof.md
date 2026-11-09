# Prove it: the restart proof

The only proof that counts is a real Mac, restarted on purpose, unlocked by the sitter with nobody touching it. `housesitter proof` records it.

```sh
housesitter proof studio --record ./proof-studio
# then restart the Mac: Apple menu > Restart (or sudo shutdown -r now over SSH)
```

Every three seconds the KVM decodes a frame and reads it itself. It sends a JPEG back only when the frame is black, shows a screen you taught it (FileVault, the lock screen, the list of users), or comes during a boot it saw. "No menu bar" isn't enough: a desktop that is logging out loses its menu bar but still shows the Dock and its badges. So your desktop, its windows and its notifications stay on the KVM (`--all-frames` keeps them too, for a private run). It saves those frames (`frame-0001.jpg`, …, at the KVM's full size) and a `timeline.json` with what each look read as, the lesson match, and the sitter's state and actions, until the Mac has been back for 30 seconds. It needs the SSH route to the KVM. Then:

```sh
ffmpeg -framerate 4 -pattern_type glob -i 'proof-studio/frame-*.jpg' -vf "scale=1280:-2" -pix_fmt yuv420p proof-studio/proof.mp4
```

What a good run shows, in order: the desktop (in the timeline only); black while it restarts; the FileVault screen; the sitter's `unlock` in the timeline; the desktop again (timeline only).

Real ones: [docs/proof/2026-11-09-v0.2](proof/2026-11-09-v0.2/), our Mac mini on 8 November, hands-off on housesitter 0.2, 70 seconds from Restart to desktop; and [docs/proof/2026-11-09](proof/2026-11-09/), the same night on 0.1, 79 seconds. Before you publish a frame with typed dots in the password field, blur the field: the dots are all the KVM ever sees, but their count is the password's length.

Publishing a proof: crop to the KVM's view, check every frame for anything private (notifications, window titles), and keep `timeline.json` beside the video so its times can be checked.
