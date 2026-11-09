# Prove it: the restart proof

The only proof that counts is a real Mac, restarted on purpose, unlocked by the sitter with nobody touching it. `housesitter proof` records it.

```sh
housesitter proof studio --record ./proof-studio
# then restart the Mac: Apple menu > Restart (or sudo shutdown -r now over SSH)
```

Every three seconds the KVM decodes a frame and reads it itself. It sends a JPEG back only when the frame isn't a desktop, so your desktop, its windows and its notifications never leave the KVM (`--all-frames` keeps them too, for a private run). It saves those frames (`frame-0001.jpg`, …, at the KVM's full size) and a `timeline.json` with what each look read as, the lesson match, and the sitter's state and actions, until the Mac has been back for 30 seconds. It needs the SSH route to the KVM. Then:

```sh
ffmpeg -framerate 4 -pattern_type glob -i 'proof-studio/frame-*.jpg' -vf "scale=1280:-2" -pix_fmt yuv420p proof-studio/proof.mp4
```

What a good run shows, in order: the desktop (in the timeline only); black while it restarts; the FileVault screen; the sitter's `unlock` in the timeline; the desktop again (timeline only).

A real one: [docs/proof/2026-11-09](proof/2026-11-09/), our Mac mini on 8 November, hands-off, 79 seconds from Restart to desktop. A frame that would show a password field with typed dots is fine: the dots are all the KVM ever sees.

Publishing a proof: crop to the KVM's view, check every frame for anything private (notifications, window titles), and keep `timeline.json` beside the video so its times can be checked.
