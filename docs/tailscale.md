# Tailscale

The KVM joins your tailnet as a tagged device that can reach nothing, so you and your agents reach it from anywhere and it can't reach you.

1. Add the policy from `housesitter tailnet-policy` to your tailnet (admin console > Access controls). It keeps your devices reaching everything, lets nothing tagged `tag:kvm` reach anything, and has tests that fail the save if a later edit breaks that.
2. Make an auth key: tagged `tag:kvm`, pre-approved, reusable if you'll re-adopt. Store it: `security add-generic-password -s housesitter -a tailnet-kvm -w` (it prompts).
3. Add to the Mac's entry in `~/.config/housesitter/config.json`:

   ```json
   "tailscale": { "tag": "tag:kvm", "hostname": "kvm-studio", "authkey": "keychain:housesitter/tailnet-kvm" }
   ```

4. Run `housesitter adopt studio` again. It passes the key through a root-only file that is emptied right after `tailscale up`, checks the tag, and records the tailnet address as the first endpoint, with the same pinned certificate.

GL.iNet's Comet also has Tailscale in its Apps Center; either way works. An agent host that can't join your tailnet (a managed laptop, a CI runner) can use the [GitHub outbox](../README.md#reach-it-from-anywhere) instead.
