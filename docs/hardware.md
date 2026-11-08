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

macOS sees the KVM as one more display. Three settings keep it out of your way:

- **Run it at 1920x1080, native** (System Settings > Displays). Higher modes can stop the KVM's capture chip from locking on, and a scaled mode makes the Mac's display scaler do extra work.
- **Extended, never mirrored**, so your own displays keep their modes.
- **Touch your main display only at one outer corner** in the arrangement, so the pointer can't wander onto a screen nobody is looking at.

## The KVM

**GL.iNet Comet PoE (GL-RM1PE)**, about $100. It runs GLKVM, GL.iNet's GPLv3 fork of PiKVM's kvmd, with the same HTTP API. What real units do, and what housesitter does about it:

| On a real unit | housesitter |
| --- | --- |
| The REST API ships **off**; every `/api/*` answers 404 | `adopt` turns it on over SSH and keeps the original nginx config. A firmware update can turn it off again; run `adopt` again after one. The sitter never needs it: it talks to kvmd's own socket. |
| A new unit's admin password is set on its first-run web page when the API is off | `adopt` makes the password, keeps it in your Keychain, puts it on the clipboard and opens the page: the one paste you do. |
| The video encoder runs only while a viewer is connected, so a headless snapshot answers 503 | Every snapshot and OCR holds a stream open first, on the KVM and over HTTPS. |
| At high resolutions a "JPEG" snapshot can be an H.264 frame | The sitter checks, and switches the encoder to MJPEG. |
| Its dropbear SSH server (2019.78 on firmware V1.7.1) refuses ed25519 keys | housesitter uses an ECDSA key. |
| kvmd can say "online" with a placeholder resolution and no frames | A picture counts only with frames coming in. |

The first three rows are [kvm-pilot](https://github.com/DustinTrap/kvm-pilot)'s findings from real units; the last two are ours, from a Comet on firmware V1.7.1 (kvmd 4.82) on 2026-11-08.

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
