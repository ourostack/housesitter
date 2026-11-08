# Hardware

## What to plug in

| Cable | From | To | Why it matters |
| --- | --- | --- | --- |
| HDMI | the Mac's own HDMI port, or a USB-C-to-HDMI adapter in one of its own ports | the KVM's HDMI in | A dock can drop the picture when the Mac restarts. |
| USB-C | the KVM's keyboard/mouse port | a port **on the Mac itself** | At the FileVault screen the Mac only sees its own ports, not a dock's or a hub's. |
| Ethernet | the KVM | your network | PoE powers the Comet too. Otherwise use its USB-C power port, from a wall adapter or a dock port that stays powered when the Mac restarts. |
| Power (optional) | the Mac's power cord | a smart plug | Lets the sitter restart a Mac that froze. |

On the Mac, once:

```sh
sudo pmset -a autorestart 1     # turn back on when power returns (after a plug cycle or an outage)
sudo pmset -a displaysleep 0    # keeps the KVM's picture alive; a dark screen reads as "can't see", and gets you a message
```

## The KVM's display on the Mac

macOS sees the KVM as one more display (the Comet shows up as "GLKVM", at 2560x1440). Set it up once, when you plug the KVM in, and then leave it alone:

- **Keep whatever mode the Mac picks.** housesitter reads any resolution, and it never changes one.
- **Extended, never mirrored**, so your own displays keep their modes.
- **Touch your main display only at one outer corner** in the arrangement, so the pointer can't wander onto a screen nobody is looking at.

**Never change the KVM's EDID, or the Mac's display mode, while the Mac is running.** On 2026-11-08 we wrote a 1080p EDID to our Comet while our Mac mini was up. The Mac switched modes and froze: no reboot and no panic, but nothing above the kernel answered. The keyboard, the force-restart chord and the password all went in through the KVM and changed nothing. Only a power cycle could bring it back, and that Mac had no smart plug yet. housesitter's client has no EDID call, and `adopt` accepts whatever mode arrives.

## The KVM

**GL.iNet Comet PoE (GL-RM1PE)**, about $100. It runs GLKVM, GL.iNet's GPLv3 fork of PiKVM's kvmd, with the same HTTP API. What real units do, and what housesitter does about it:

| On a real unit | housesitter |
| --- | --- |
| The REST API ships **off**; every `/api/*` answers 404 | `adopt` turns it on over SSH and keeps the original nginx config. A firmware update can turn it off again; run `adopt` again after one. The sitter never needs it: it talks to kvmd's own socket. |
| A new unit's admin password is set on its first-run web page when the API is off | `adopt` makes the password, keeps it in your Keychain, puts it on the clipboard and opens the page: the one paste you do. |
| The video encoder runs only while a viewer is connected, so a headless snapshot answers 503 | Every snapshot and OCR holds a stream open first, on the KVM and over HTTPS. |
| At high resolutions a "JPEG" snapshot can be an H.264 frame | The sitter checks and tries MJPEG. On firmware V1.7.1 at 2560x1440 that changes nothing, so it puts the encoder back and decodes one keyframe on the KVM itself with its own `ffmpeg` (about 2 s). |
| On firmware V1.7.1 at 2560x1440, kvmd's OCR answers HTTP 500 (no tesseract on the device) | The sitter reads its own decoded frames instead: a menu bar means a desktop (and the clock at its right end must keep changing), and a steady screen with no menu bar **right after the Mac booted** is the FileVault prompt (the boot watch, below). |
| A Mac boot re-enumerates the KVM's USB keyboard; HDMI coming back alone does not | That is how the boot watch knows a boot from a display that woke up. |
| Its dropbear SSH server (2019.78 on firmware V1.7.1) refuses ed25519 keys | housesitter uses an ECDSA key. |
| kvmd can say "online" with a placeholder resolution and no frames | A picture counts only with frames coming in. |

The first four rows are [kvm-pilot](https://github.com/DustinTrap/kvm-pilot)'s findings from real units; the rest are ours, from a Comet on firmware V1.7.1 (kvmd 4.82) next to a Mac mini on 2026-11-08.

### The boot watch: knowing the FileVault screen without OCR

Every 2 seconds the sitter checks two things it can read for free: when the Mac last enumerated the KVM's keyboard (`dmesg`), and whether HDMI has a signal. A new enumeration means the Mac booted. For the next 15 minutes, it decodes a frame every 3 seconds. The frame counts as the password prompt when it has no menu bar, has settled for at least 20 seconds after the boot, and stays the same across two frames. Then the sitter types the password and Return. If it sees no desktop 40 seconds later, it tries once more, and after that it stops and messages you. That is at most two tries a boot and three an hour, shared with every other unlock. HDMI coming back without a boot never arms it, so a display waking up or a full-screen app never gets the password. The recogniser was built and tested on real frames from that Comet and Mac mini (`test/fixtures/comet-frames-20261108.json`: brightness, edge counts and 32x18 thumbnails, never full pictures). It hasn't yet unlocked a real FileVault screen.

**Other PiKVM-API KVMs** (PiKVM itself, BliKVM) should work: the client and the sitter use only kvmd's API and socket. On PiKVM, add the key `adopt` makes (`~/.ssh/housesitter-<mac>-ecdsa.pub`) to root's `authorized_keys` once. Not tried yet.

## Power

| Adapter | Config | Notes |
| --- | --- | --- |
| Shelly Gen2+ / Gen4 plug, Wi-Fi | `{"kind": "shelly", "url": "http://192.168.1.60"}` | `Switch.Set` with `toggle_after`, so the plug switches itself back on even if the sitter dies mid-cycle. Set the plug to turn on after a power outage. |
| The same plug over Bluetooth | `{"kind": "shelly-ble", "mac": "AA:BB:…"}` | For a network the plug can't join (a captive-portal guest network). Needs a USB Bluetooth adapter in the KVM and Python's `bleak` on it. Not yet verified. |
| Anything with a CLI | `{"kind": "command", "cycle": "…", "on": "…", "status": "…"}` | Home Assistant, a relay, another plug. Commands run without a shell. |
| Fingerbot on the power button | `{"kind": "fingerbot"}` | Through GLKVM's Fingerbot API. On a Mac mini the button is underneath at the back. |
| ATX board | — | Not for Macs: there is no ATX header. |

Without a plug the sitter still unlocks FileVault and tells you about a hang; it just can't fix one.
