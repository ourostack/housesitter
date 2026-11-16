// Housesitter's command table, declared with Ouro AX's kit. The kit checks every call against it: the words and flags a
// command takes, the --why an action other people see needs, and the one-line refusals. bin/housesitter.mjs still runs
// each command through its own switch, after the kit has checked the call; a handler moves to returning data one at a
// time. `effect` says who sees a command: "others" when it acts on the Mac or sends a message, "private" when only the
// person sees it.
import { defineCli, defineCommand, parse } from '../lib/ouro-ui/registry/ouro/ax/command.ts';
import { BASE_EXIT_CODES, defineExitCodes, FINDINGS_EXIT_CODE } from '../lib/ouro-ui/registry/ouro/ax/exit-codes.ts';
import { runCli } from '../lib/ouro-ui/registry/ouro/ax/cli.ts';
import { AxError } from '../lib/ouro-ui/registry/ouro/ax/problem.ts';

const mac = (description = 'the Mac, as its name in the config') => ({ name: 'mac', description });
const word = (name, description, extra = {}) => ({ name, description, ...extra });
const cmd = (def) => defineCommand(def);

// Every flag the commands read. A flag a command does not read is still unknown to the kit: flags are checked across
// the tool, not per command, until a command declares its own.
const VALUE_FLAGS = ['--address', '--stale-min', '--disk-floor-gb', '--always-on', '--from', '--out', '--max-width', '--record', '--minutes', '--picture', '--home', '--notify', '--email', '--silent-min', '--watched-by', '--location', '--fingerprint', '--every', '--re', '--to', '--agent', '--ouro', '--also', '--skip', '--hackamore', '--app', '--settle', '--settle-max', '--grace', '--person-wait', '--copilot-home', '--cooldown-hours', '--floor-gib', '--window', '--listing', '--peer', '--config', '--grid', '--address', '--ref', '--clone'];
const SWITCH_FLAGS = ['--again', '--all-frames', '--api-open', '--attended', '--attended-test', '--base64', '--detach', '--disk-prune', '--double', '--end', '--expect-reboot', '--fake', '--fast', '--filevault', '--heartbeat', '--hold', '--i-see-the-field', '--install', '--install-agent', '--install-keeper', '--install-plugin-updates', '--install-recovery', '--list', '--no-sessions', '--now', '--once', '--open-at-login', '--os-updates', '--outbox', '--peek', '--plain', '--plugin-updates', '--private', '--quiet', '--repair', '--resume', '--resume-only', '--right', '--sigterm', '--status', '--test', '--this-mac', '--trial', '--uninstall', '--uninstall-agent', '--uninstall-plugin-updates', '--uninstall-recovery', '--version', '--watch', '--yes'];

const FLAGS = Object.fromEntries([
  ...VALUE_FLAGS.map((f) => [f.slice(2), { type: 'string', description: 'a value the Mac commands read; see docs/usage.md' }]),
  ...SWITCH_FLAGS.map((f) => [f.slice(2), { type: 'boolean', description: 'a switch the Mac commands read; see docs/usage.md' }]),
]);

// Commands that act on the Mac or send a message: other people see them, so the kit needs --why, and a --dry-run that
// does not act is answered with what it would do. adopt, restart-copilot and laptop-arrival keep their own --dry-run.
const OWN_DRY_RUN = new Set(['adopt', 'restart-copilot', 'laptop-arrival']);

// --why is for an action someone asked for. A dry run or a --status look acts on nothing, and a job the person installed
// on a timer runs as the person set it up, so these run without one. Each list is the flags a command's installed job
// passes (AGENTS in src/recovery.mjs, the crash-resume, Apple Account, laptop-arrival and peer-watch installers).
const SCHEDULED = {
  'restart-copilot': ['heartbeat', 'disk-prune', 'plugin-updates', 'os-updates', 'resume-only'],
  'apple-account': ['watch'],
  'laptop-arrival': ['quiet'],
  'peer watch': ['every', 'once'],
};
const WHY = { type: 'string', required: true, placeholder: '"who asked you, and what they said"', description: 'Who asked you, and what they said, like "Riley asked me to post the banner"; it is logged with the action.' };

const COMMANDS = [
  cmd({ name: 'demo', summary: 'the real evening it was built for, replayed (no hardware)', effect: 'private', readOnly: true, args: [word('name', 'night, for one bad night, rehearsed', { required: false })], examples: ['housesitter demo', 'housesitter demo night'] }),
  cmd({ name: 'adopt', summary: 'set up a new KVM next to a Mac: three cables in, then this', effect: 'private', args: [mac()], examples: ['housesitter adopt <mac> --address <ip>'] }),
  cmd({ name: 'secret', summary: 'store a secret for a Mac (read from stdin, no echo)', effect: 'private', args: [mac(), word('kind', 'mac-password, kvm-admin, outbox-token, ntfy-token or apple-account')], examples: ['housesitter secret <mac> <mac-password|kvm-admin|outbox-token|ntfy-token|apple-account>'] }),
  cmd({ name: 'apple-account', summary: 'the Apple Account password prompt after an update reboot', effect: 'others', args: [mac()], examples: ['housesitter apple-account <mac> --status'] }),
  cmd({ name: 'proof', summary: 'record what the KVM sees while you restart the Mac', effect: 'private', args: [mac()], examples: ['housesitter proof <mac> --record <dir>'] }),
  cmd({ name: 'plug', summary: 'the smart plug on the Mac\'s cord: find, adopt, read, or prove it', effect: 'others', args: [mac(), word('action', 'find, adopt, status or prove'), word('ip', 'the plug\'s address, for adopt', { required: false })], examples: ['housesitter plug <mac> status'] }),
  cmd({ name: 'doctor', summary: 'everything in one screen: what the KVM sees, the Mac, the budgets', effect: 'private', readOnly: true, args: [{ ...mac('the Mac; without one, this computer\'s setup'), required: false }], examples: ['housesitter doctor <mac> --private'] }),
  cmd({ name: 'status', summary: 'whether the Mac\'s KVM and sitter are reachable, and what they see', effect: 'private', readOnly: true, args: [mac()], examples: ['housesitter status <mac>'] }),
  cmd({ name: 'look', summary: 'one read-only look at the screen', effect: 'private', readOnly: true, args: [{ ...mac(), required: false }], examples: ['housesitter look <mac>'] }),
  cmd({ name: 'screenshot', summary: 'the KVM\'s picture of the screen, saved as a JPEG', effect: 'private', readOnly: true, args: [mac()], examples: ['housesitter screenshot <mac> --out shot.jpg'] }),
  cmd({ name: 'click', summary: 'click at a point in the last screenshot\'s pixels', effect: 'others', args: [mac(), word('x', 'the point\'s x, in the screenshot\'s pixels'), word('y', 'the point\'s y, in the screenshot\'s pixels')], examples: ['housesitter click <mac> <x> <y>'] }),
  cmd({ name: 'type', summary: 'type text on the Mac through the KVM', effect: 'others', args: [mac(), word('text', 'the text to type', { rest: true })], examples: ['housesitter type <mac> <text>'] }),
  cmd({ name: 'key', summary: 'press a key or combo on the Mac through the KVM', effect: 'others', args: [mac(), word('combo', 'a key or combo, such as Return or cmd+space')], examples: ['housesitter key <mac> <combo>'] }),
  cmd({ name: 'scroll', summary: 'scroll on the Mac through the KVM', effect: 'others', args: [mac(), word('direction', 'up or down'), word('amount', 'how many notches', { required: false })], examples: ['housesitter scroll <mac> <up|down> [n]'] }),
  cmd({ name: 'computer', summary: 'run one Anthropic computer-use action, as it is', effect: 'others', args: [mac(), word('computer_action', 'the action, as one JSON object')], examples: ['housesitter computer <mac> \'<json>\''] }),
  cmd({ name: 'unlock', summary: 'ask the sitter to unlock the Mac (it keeps its own limits and checks)', effect: 'others', args: [mac()], examples: ['housesitter unlock <mac>'] }),
  cmd({ name: 'power-cycle', summary: 'ask the sitter to power-cycle the Mac', effect: 'others', args: [mac()], examples: ['housesitter power-cycle <mac> --attended'] }),
  cmd({ name: 'power-on', summary: 'ask the sitter to power the Mac on', effect: 'others', args: [mac()], examples: ['housesitter power-on <mac>'] }),
  cmd({ name: 'want-desktop', summary: 'unlock now so an agent can drive the UI, and again if it locks meanwhile', effect: 'others', args: [mac()], examples: ['housesitter want-desktop <mac> --minutes 10'] }),
  cmd({ name: 'watch-kvm', summary: 'a LaunchAgent that checks the KVM each minute and says if it goes silent', effect: 'private', args: [mac()], examples: ['housesitter watch-kvm <mac> --install'] }),
  cmd({ name: 'alert-test', summary: 'one real "I\'m stuck" message through the rules, marked TEST', effect: 'others', args: [mac()], examples: ['housesitter alert-test <mac>'] }),
  cmd({ name: 'learn-prompt', summary: 'teach it the prompt you see on the KVM', effect: 'private', args: [mac(), word('x', 'with --grid: the tile\'s x, as a fraction of the screen', { required: false }), word('y', 'with --grid: the tile\'s y, as a fraction of the screen', { required: false })], examples: ['housesitter learn-prompt <mac> --i-see-the-field'] }),
  cmd({ name: 'forget', summary: 'wipe the secrets from the KVM and stop the sitter', effect: 'private', args: [mac()], examples: ['housesitter forget <mac> --yes'] }),
  cmd({ name: 'ls', summary: 'the Mac as state, plus the actions available now (Ouro Reins)', effect: 'private', readOnly: true, args: [mac()], examples: ['housesitter ls <mac>'] }),
  cmd({ name: 'do', summary: 'run one action the Mac offers now', effect: 'others', args: [mac(), word('action', 'an action ls names'), word('input', 'its input, as one JSON object', { required: false })], examples: ['housesitter do <mac> <action> \'<json>\''] }),
  cmd({ name: 'peer send', summary: 'send a message to Housesitter, the agent on the KVM (through a secret gist, within 6 minutes)', effect: 'others', args: [word('text', 'the message', { rest: true })], examples: ['housesitter peer send <text>'] }),
  cmd({ name: 'peer inbox', summary: 'read Housesitter\'s new messages, oldest first, each shown once', effect: 'private', examples: ['housesitter peer inbox'] }),
  cmd({ name: 'peer flush', summary: 'send the queued messages if they are due', effect: 'others', args: [mac('the Mac this link is for, as its name in the config')], examples: ['housesitter peer flush <mac> --now'] }),
  cmd({ name: 'peer watch', summary: 'wake the agent with ouro msg when Housesitter writes, and send queued messages when due', effect: 'others', args: [mac('the Mac this link is for, as its name in the config')], examples: ['housesitter peer watch <mac> --once'] }),
  cmd({ name: 'peer drill', summary: 'mark a planned drill: the link labels everything sent meanwhile', effect: 'others', args: [word('label', 'what the drill is', { required: false, rest: true })], examples: ['housesitter peer drill "gist outage" --minutes 60'] }),
  cmd({ name: 'restart-copilot', summary: 'restart the GitHub Copilot app without losing any session\'s work', effect: 'others', flags: { mac: { type: 'string', description: 'with --install-recovery: the Mac whose apple-account agent to install too' } }, examples: ['housesitter restart-copilot --dry-run'] }),
  cmd({ name: 'deploy', summary: 'make a tool\'s release live in one atomic swap (housesitter or shepherd)', effect: 'others', args: [word('name', 'housesitter or shepherd')], examples: ['housesitter deploy housesitter --dry-run', 'housesitter deploy shepherd --ref v0.3.1'] }),
  cmd({ name: 'steer', summary: 'whether another computer can see and drive this Mac\'s agent sessions', effect: 'private', examples: ['housesitter steer --list'] }),
  cmd({ name: 'laptop-arrival', summary: 'when a Mac that was away is back, bring it up to date and tell the agent once', effect: 'others', args: [mac('the Mac that was away, as its name in the config')], examples: ['housesitter laptop-arrival <mac> --dry-run'] }),
  cmd({ name: 'fleet', summary: 'every Mac side by side, from the fleet gist\'s health records', effect: 'private', readOnly: true, examples: ['housesitter fleet --stale-min 15'] }),
  cmd({ name: 'tailnet-policy', summary: 'a Tailscale policy where the KVM reaches nothing', effect: 'private', readOnly: true, examples: ['housesitter tailnet-policy'] }),
  cmd({ name: 'version', summary: 'print the version', effect: 'private', readOnly: true, examples: ['housesitter version'] }),
].map((c) => (c.effect === 'others'
  ? {
    ...c,
    why: 'required',
    flags: { ...c.flags, why: { ...WHY, unless: ['dry-run', 'status', ...(SCHEDULED[c.name] ?? [])] } },
    ...(c.examples ? { examples: c.examples.map((e) => (/--(dry-run|status)\b/.test(e) ? e : `${e} --why "the person asked"`)) } : {}),
  }
  : c));

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
  globalFlags: FLAGS,
  groups: { peer: 'talk to Housesitter, the agent on the KVM: peer send, peer inbox' },
  commands: COMMANDS,
});

// The kit lists groups separately by effect. Hide the private row only in the text overview; command help, JSON
// manifests and parsing still use the full table and retain each command's actual effect.
const overviewCli = {
  ...cli,
  commands: cli.commands.map((c) => c.name === 'peer inbox' ? { ...c, hidden: true } : c),
};

export async function runHelp(argv, io) {
  let parsed;
  try {
    parsed = parse(cli, argv);
  } catch (e) {
    if (!(e instanceof AxError)) throw e;
    return runCli(cli, argv, io);
  }
  const overview = parsed.kind === 'help' && parsed.topic === undefined && !parsed.json;
  return runCli(overview ? overviewCli : cli, argv, io);
}

/**
 * Whether bin/housesitter.mjs runs argv through its own switch. Help (`help`, `--help`, `-h`, a command's own help) and
 * an unknown command are the kit's, which answers them and exits.
 */
export function isCommand(argv) {
  const word = argv.find((a) => !a.startsWith('-'));
  if (word === 'help' || argv.includes('--help') || argv.includes('-h')) return false;
  const heads = new Set(COMMAND_WORDS.map((w) => w.split(' ')[0]));
  return argv.some((a) => heads.has(a));
}

/**
 * The kit's check of one call: null when it is well formed, else the kit's refusal, printed as the kit prints it (one
 * line on stderr, or the outcome as JSON), with its exit code.
 */
export async function refusalOf(argv, io) {
  try {
    parse(cli, argv);
    return null;
  } catch {
    return { exit: await runCli(cli, argv, io) };
  }
}

/**
 * What a `--dry-run` of an acting command would do, without doing it: null when the command is not previewed here
 * (it is not an acting command, or it keeps its own --dry-run), else the one line the person reads.
 */
export function previewOf(argv) {
  const parsed = parse(cli, argv);
  const name = parsed.command.name;
  if (parsed.command.effect !== 'others' || OWN_DRY_RUN.has(name) || parsed.input['dry-run'] !== true) return null;
  return `${name}: dry run; nothing was done. Without --dry-run this acts for the person, and other people see it.`;
}
