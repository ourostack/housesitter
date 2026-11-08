# Prove it: the restart proof

The only proof that counts is a real Mac, restarted on purpose, unlocked by the sitter with nobody touching it. `housesitter proof` records it.

```sh
housesitter proof studio --record ./proof-studio
# then restart the Mac: Apple menu > Restart (or sudo shutdown -r now over SSH)
```

It saves what the KVM sees every two seconds (`frame-0001.jpg`, …) and a `timeline.json` with the sitter's state and actions beside each frame, until the Mac has been back for 30 seconds. Then:

```sh
ffmpeg -framerate 4 -pattern_type glob -i 'proof-studio/frame-*.jpg' -vf "scale=1280:-2" -pix_fmt yuv420p proof-studio/proof.mp4
```

What a good run shows, in order: the desktop; black while it restarts; the FileVault screen; the sitter's `unlock` in the timeline; the desktop again. A frame that would show a password field with typed dots is fine: the dots are all the KVM ever sees.

Publishing a proof: crop to the KVM's view, check every frame for anything private (notifications, window titles), and keep `timeline.json` beside the video so its times can be checked.
