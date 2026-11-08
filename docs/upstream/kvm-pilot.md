# What we'll send to kvm-pilot

[kvm-pilot](https://github.com/DustinTrap/kvm-pilot) only accepts quirks seen on real hardware, and so do we. Nothing goes upstream until our own Comet has shown it.

After the first restart proof on our Comet (GL-RM1PE, firmware V1.7.1, kvmd 4.82):

1. **A hardware report**, in its issue template: firmware version, whether the REST API shipped off, whether a 1080p snapshot was a JPEG, the GL cloud toggle, and what an Apple Silicon Mac's FileVault screen looks like through it (does the keyboard work there, does pre-boot draw on the KVM's display, what the KVM's OCR reads).
2. **dropbear and ed25519:** firmware V1.7.1 runs dropbear 2019.78, which refuses ed25519 keys. Worth a line in its GLKVM onboarding doc.
3. **"online" with no frames:** kvmd reported the source online at a placeholder 1920x1080 with no HDMI lock; `captured_fps` tells them apart.
4. **If `enable-api` holds up on the real unit,** offer it as an appliance-SSH helper for its "every /api call returns 404" troubleshooting entry.
5. **A `filevault_prompt` phase** for its screen classifier, if it wants Mac pre-boot as a phase.
