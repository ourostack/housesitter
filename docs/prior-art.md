# Prior art, and what we took

We looked around before building (2026-11-08). Each entry: what it is, and whether we **adopt** it, **borrow** an idea, **watch** it, or **ignore** it.

| Project | What it is | Verdict | What we took or why not |
| --- | --- | --- | --- |
| [kvm-pilot](https://github.com/DustinTrap/kvm-pilot) | Apache-2.0 MCP server, CLI and Python library for agents driving machines through PiKVM/GLKVM, BMCs and Intel AMT, with a vision loop that names boot phases | **Borrow, and contribute back** | Its live GL-RM1PE findings (API off, on-demand encoder, MJPEG flip) are built into housesitter. Its read-only-first trust ladder and `llms.txt` are good habits we copied. It's a client an agent drives; housesitter is a sitter that lives on the KVM and acts with nobody driving, for Macs (FileVault, smart-plug power). Our hardware reports go back to it ([plan](upstream/kvm-pilot.md)). |
| [PiKVM](https://docs.pikvm.org/api/) | The open KVM and the kvmd API | **Adopt** | The API we speak, its OCR, `hid/print` with slow typing, and the unix socket the sitter uses. Its [Tailscale guide](https://docs.pikvm.org/tailscale/). |
| [GLKVM](https://github.com/gl-inet/glkvm) | GL.iNet's GPLv3 fork of kvmd on the Comet | **Adopt** (as the target) | First-run API, Fingerbot API, `ssh_key` API, Astrowarp cloud toggle. |
| [JetKVM](https://github.com/jetkvm/kvm) | Open KVM, WebRTC-first | **Watch** | Its [issue #56](https://github.com/jetkvm/kvm/issues/56) confirms the Mac pre-boot keyboard problem across vendors; the virtual-media-off fix is in `adopt`. |
| NanoKVM | Low-cost RISC-V KVM | **Watch** | Its [undocumented microphone](https://github.com/sipeed/NanoKVM/issues/693) is why [security.md](../docs/security.md) says to check yours. |
| TinyPilot | Pi-based KVM | **Ignore** | Nothing it does that PiKVM's API doesn't. |
| [`apple_ssh_and_filevault(7)`](https://github.com/apple-oss-distributions/OpenSSH/blob/main/apple_ssh_and_filevault.7) | macOS 26: unlock FileVault over SSH before boot | **Recommend alongside** | Needs Remote Login on and the network up before boot; doesn't help a hang. Use it where you can. |
| `fdesetup authrestart` | One FileVault-free restart, planned | **Borrow** | Good for a planned restart; no help after a panic or power loss. |
| Mac hosting (MacStadium, AWS EC2 Mac, colos) | Rented Macs in racks | **Ignore** | They mostly answer FileVault with "a person, or turn it off". That gap is why housesitter exists. |
| [Tailscale tags](https://tailscale.com/kb/1068/tags) | Device identity without a user | **Adopt** | `tag:kvm` with no outbound grants, and policy tests. |
| [Anthropic computer use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool) | The action vocabulary agents know | **Adopt** | `computer()` takes its input as-is: `screenshot`, `left_click`, `type`, `key`, `scroll`… |
| [Cua](https://github.com/trycua/cua) | Computer-use agents in macOS VMs | **Watch** | The nearest idea, for VMs. housesitter is for the real Mac. |
| Kubernetes Node Problem Detector | Detection apart from remediation, with budgets | **Borrow** | The watchdog's shape: observe, decide with pure rules, act within budgets, escalate once. |
| [ntfy](https://ntfy.sh) | Push notifications by HTTP POST | **Adopt** | The default notify target. |

Landing-page patterns we borrowed: a one-line outcome first (Tailscale), a quickstart that fits on one screen (uv, Bun), a demo you can run without signing up, an honest status table, one diagram per idea.
