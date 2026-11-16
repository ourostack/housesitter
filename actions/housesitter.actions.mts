// The Housesitter commands an agent may run, declared once. `ouro-actions.mts generate` writes what each surface needs
// into actions/generated/; never edit that folder.
import { defineAction, defineActions, field } from "../tools/ouro-actions/ouro-actions.mts";

export const status = defineAction({
  id: "status",
  consent: "read",
  label: "Status",
  description: "Show whether the Mac's KVM and its sitter are reachable and what they see.",
  agent: "Read the Mac's KVM and sitter state: whether the KVM is reached, what the video and keyboard show, and the sitter's state. Changes nothing.",
  input: {},
  output: {
    report: field.string({ label: "Status", description: "The status as one JSON object: name, kvm, sitter and sitter_via." }),
  },
});

export const look = defineAction({
  id: "look",
  consent: "read",
  label: "Look",
  description: "Take one read-only look at the Mac's screen through the KVM.",
  agent: "Take one look at the Mac's screen through its KVM and report what the sitter sees. Changes nothing.",
  input: {},
  output: {
    look: field.string({ label: "Look", description: "The look as one JSON object: the screen's state and the sitter's reading." }),
  },
});

export default defineActions("housesitter", [status, look], { tool: "housesitter" });
