// Housesitter's command table, declared with Ouro AX's kit. The kit answers help, `--help`, `help --json` and unknown
// commands from it; bin/housesitter.mjs still runs every command, through its own switch, until each one returns data.
// A command here is `loose` while its flags pass through unchecked; `effect` says who sees it: "others" when it acts on
// the Mac or sends a message, "private" when only the person sees it.
import { defineCli, defineCommand } from '../lib/ouro-ui/registry/ouro/ax/command.ts';
import { BASE_EXIT_CODES, defineExitCodes, FINDINGS_EXIT_CODE } from '../lib/ouro-ui/registry/ouro/ax/exit-codes.ts';

// `why` is optional until a handler returns data: a loose command's flags are the handler's to check, not the kit's.
const cmd = (def) => defineCommand({ loose: true, why: 'optional', ...def });

const COMMANDS = [
  cmd({ name: 'demo', summary: 'the real evening it was built for, replayed (no hardware)', effect: 'private', readOnly: true, examples: ['housesitter demo', 'housesitter demo night'] }),
  cmd({ name: 'adopt', summary: 'set up a new KVM next to a Mac: three cables in, then this', effect: 'private', examples: ['housesitter adopt <mac> --address <ip>'] }),
  cmd({ name: 'secret', summary: 'store a secret for a Mac (read from stdin, no echo)', effect: 'private', examples: ['housesitter secret <mac> <mac-password|kvm-admin|outbox-token|ntfy-token|apple-account>'] }),
  cmd({ name: 'apple-account', summary: 'the Apple Account password prompt after an update reboot', effect: 'others', examples: ['housesitter apple-account <mac> --status'] }),
  cmd({ name: 'proof', summary: 'record what the KVM sees while you restart the Mac', effect: 'private', examples: ['housesitter proof <mac> --record <dir>'] }),
  cmd({ name: 'plug', summary: 'the smart plug on the Mac\'s cord: find, adopt, read, or prove it', effect: 'others', examples: ['housesitter plug <mac> status'] }),
  cmd({ name: 'doctor', summary: 'everything in one screen: what the KVM sees, the Mac, the budgets', effect: 'private', readOnly: true, examples: ['housesitter doctor <mac> --private'] }),
  cmd({ name: 'status', summary: 'whether the Mac\'s KVM and sitter are reachable, and what they see', effect: 'private', readOnly: true, examples: ['housesitter status <mac>'] }),
  cmd({ name: 'look', summary: 'one read-only look at the screen', effect: 'private', readOnly: true, examples: ['housesitter look <mac>'] }),
  cmd({ name: 'screenshot', summary: 'the KVM\'s picture of the screen, saved as a JPEG', effect: 'private', readOnly: true, examples: ['housesitter screenshot <mac> --out shot.jpg'] }),
  cmd({ name: 'click', summary: 'click at a point in the last screenshot\'s pixels', effect: 'others', examples: ['housesitter click <mac> <x> <y>'] }),
  cmd({ name: 'type', summary: 'type text on the Mac through the KVM', effect: 'others', examples: ['housesitter type <mac> <text>'] }),
  cmd({ name: 'key', summary: 'press a key or combo on the Mac through the KVM', effect: 'others', examples: ['housesitter key <mac> <combo>'] }),
  cmd({ name: 'scroll', summary: 'scroll on the Mac through the KVM', effect: 'others', examples: ['housesitter scroll <mac> <up|down> [n]'] }),
  cmd({ name: 'computer', summary: 'run one Anthropic computer-use action, as it is', effect: 'others', examples: ['housesitter computer <mac> \'<json>\''] }),
  cmd({ name: 'unlock', summary: 'ask the sitter to unlock the Mac (it keeps its own limits and checks)', effect: 'others', examples: ['housesitter unlock <mac>'] }),
  cmd({ name: 'power-cycle', summary: 'ask the sitter to power-cycle the Mac', effect: 'others', examples: ['housesitter power-cycle <mac> --attended'] }),
  cmd({ name: 'power-on', summary: 'ask the sitter to power the Mac on', effect: 'others', examples: ['housesitter power-on <mac>'] }),
  cmd({ name: 'want-desktop', summary: 'unlock now so an agent can drive the UI, and again if it locks meanwhile', effect: 'others', examples: ['housesitter want-desktop <mac> --minutes 10'] }),
  cmd({ name: 'watch-kvm', summary: 'a LaunchAgent that checks the KVM each minute and says if it goes silent', effect: 'private', examples: ['housesitter watch-kvm <mac> --install'] }),
  cmd({ name: 'alert-test', summary: 'one real "I\'m stuck" message through the rules, marked TEST', effect: 'others', examples: ['housesitter alert-test <mac>'] }),
  cmd({ name: 'learn-prompt', summary: 'teach it the prompt you see on the KVM', effect: 'private', examples: ['housesitter learn-prompt <mac> --i-see-the-field'] }),
  cmd({ name: 'forget', summary: 'wipe the secrets from the KVM and stop the sitter', effect: 'private', examples: ['housesitter forget <mac> --yes'] }),
  cmd({ name: 'ls', summary: 'the Mac as state, plus the actions available now (Ouro Reins)', effect: 'private', readOnly: true, examples: ['housesitter ls <mac>'] }),
  cmd({ name: 'do', summary: 'run one action the Mac offers now', effect: 'others', examples: ['housesitter do <mac> <action> \'<json>\''] }),
  cmd({ name: 'peer', summary: 'talk with Housesitter, the agent on the KVM: send, inbox, flush, watch, drill', effect: 'others', examples: ['housesitter peer send <text>', 'housesitter peer inbox'] }),
  cmd({ name: 'restart-copilot', summary: 'restart the GitHub Copilot app without losing any session\'s work', effect: 'others', examples: ['housesitter restart-copilot --dry-run'] }),
  cmd({ name: 'steer', summary: 'whether another computer can see and drive this Mac\'s agent sessions', effect: 'private', examples: ['housesitter steer --list'] }),
  cmd({ name: 'laptop-arrival', summary: 'when a Mac that was away is back, bring it up to date and tell the agent once', effect: 'others', examples: ['housesitter laptop-arrival --dry-run'] }),
  cmd({ name: 'fleet', summary: 'every Mac side by side, from the fleet gist\'s health records', effect: 'private', readOnly: true, examples: ['housesitter fleet --stale-min 15'] }),
  cmd({ name: 'tailnet-policy', summary: 'a Tailscale policy where the KVM reaches nothing', effect: 'private', readOnly: true, examples: ['housesitter tailnet-policy'] }),
  cmd({ name: 'version', summary: 'print the version', effect: 'private', readOnly: true, examples: ['housesitter version'] }),
];

/** Every command word the table declares, in the order the overview lists them. */
export const COMMAND_WORDS = COMMANDS.map((c) => c.name);

/**
 * The CLI as Ouro AX sees it. Its exit codes are the kit's base codes plus the findings code (3), which `doctor` and
 * `fleet` use when a check finds a problem.
 */
export const cli = defineCli({
  name: 'housesitter',
  about: [
    "housesitter: your agents' Mac, looked after while you're away.",
    'Use it to see the Mac, unlock it after a panic, power-cycle a hang, and say what happened.',
  ],
  exits: defineExitCodes([...BASE_EXIT_CODES, FINDINGS_EXIT_CODE]),
  commands: COMMANDS,
});

/**
 * Whether bin/housesitter.mjs runs argv through its own switch. Help (`help`, `--help`, `-h`, a command's own help) and
 * an unknown command are the kit's, which answers them and exits.
 */
export function isCommand(argv) {
  const word = argv.find((a) => !a.startsWith('-'));
  if (word === 'help' || argv.includes('--help') || argv.includes('-h')) return false;
  return argv.some((a) => COMMAND_WORDS.includes(a));
}
