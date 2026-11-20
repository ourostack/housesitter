// The command table and the dispatcher must name the same commands, and help, `help --json` and unknown commands come
// from the kit: pure JSON on stdout, exit codes from the table, no voice line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_WORDS, isCommand } from '../src/cli-table.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin/housesitter.mjs');
const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

test('the dispatcher handles exactly the commands the table declares', () => {
  const src = fs.readFileSync(BIN, 'utf8');
  const dispatched = new Set([...src.matchAll(/cmd === '([a-z-]+)'/g)].map((m) => m[1]));
  for (const word of ['unlock', 'power-cycle', 'power-on']) dispatched.add(word);
  dispatched.delete('help');
  assert.deepEqual([...dispatched].sort(), [...new Set(COMMAND_WORDS.map((w) => w.split(' ')[0]))].sort());
});

test('help --json is the kit\'s: pure JSON that lists every command with its effect', () => {
  const r = run(['help', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const help = JSON.parse(r.stdout);
  assert.deepEqual(help.commands.map((c) => c.name).sort(), [...COMMAND_WORDS].sort());
  for (const c of help.commands) assert.ok(['private', 'others'].includes(c.effect), c.name);
  assert.equal(help.commands.find((c) => c.name === 'peer inbox').effect, 'private');
  assert.equal(help.commands.find((c) => c.name === 'peer send').effect, 'others');
  assert.deepEqual(help.exitCodes.map((e) => e.name), ['ok', 'error', 'usage', 'findings']);
});

test('the overview lists peer once with the group summary', () => {
  for (const args of [['help'], ['--help']]) {
    const r = run(args);
    assert.equal(r.status, 0, r.stderr);
    const rows = r.stdout.split('\n').filter((line) => /^\s+peer\s/.test(line));
    assert.equal(rows.length, 1);
    assert.match(rows[0], /talk to Housesitter, the agent on the KVM: peer send, peer inbox/);
  }
});

test('version and tailnet-policy return JSON without changing their plain output', () => {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const policy = fs.readFileSync(path.join(ROOT, 'docs/tailnet-policy.hujson'), 'utf8');
  for (const [command, key, value] of [['version', 'version', version], ['tailnet-policy', 'policy', policy]]) {
    const plain = run([command]);
    const json = run([command, '--json']);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(plain.stdout, `${value}\n`);
    assert.deepEqual(JSON.parse(json.stdout), { [key]: value });
  }
});

test('an unknown command exits 2 with one line on stderr and nothing on stdout', () => {
  const r = run(['no-such-command']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /there is no command "no-such-command"/);
});

test('help and a command\'s own help go to the kit; a command word runs the dispatcher', () => {
  assert.equal(isCommand(['help', 'status']), false);
  assert.equal(isCommand(['status', '--help']), false);
  assert.equal(isCommand(['--json', 'help']), false);
  assert.equal(isCommand(['status', 'studio']), true);
  assert.equal(isCommand(['--address', '10.0.0.5', 'adopt']), true);
});


test('a peer link names a Mac the config knows; a returning Mac is the one laptop-arrival.json names; an unknown one is refused with the known names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-mac-'));
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ macs: { studio: {} } }));
  const env = { ...process.env, HOUSESITTER_CONFIG: config };
  const unknown = spawnSync(process.execPath, [BIN, 'peer', 'flush', 'nope', '--why', 'the person asked'], { encoding: 'utf8', env });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /no Mac called "nope".*studio/);
  // The returning Mac is the file's `peer`, a Mac with no KVM that config.json does not list: no refusal, no name needed.
  const arrival = path.join(dir, 'laptop-arrival.json');
  fs.writeFileSync(arrival, JSON.stringify({ peer: 'laptop', route: ['/bin/true'] }));
  const back = spawnSync(process.execPath, [BIN, 'laptop-arrival', '--config', arrival, '--status', '--json'], { encoding: 'utf8', env: { ...env, HOME: dir } });
  assert.doesNotMatch(back.stderr, /no Mac called/);
  assert.equal(back.status, 0, back.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 2026-11-16: #98 made every acting command need --why, and every installed launchd job (heartbeat, health watch,
// plugin and OS updates, crash resume, the Apple Account watch, laptop arrival) began failing with "needs --why",
// so freeze and crash recovery stopped. A scheduled job the person installed, a read-only look and a dry run act for
// no one new, so they run without --why; an agent's own restart still needs one.
test('installed jobs, read-only looks and dry runs run without --why; an agent\'s restart still needs one', async () => {
  const { cli } = await import('../src/cli-table.mjs');
  const { parse } = await import('../lib/ouro-ui/registry/ouro/ax/command.ts');
  const { AGENTS } = await import('../src/recovery.mjs');
  const refusal = (argv) => { try { parse(cli, argv); return null; } catch (e) { return e.shape?.code ?? String(e); } };
  const needsWhy = (argv) => refusal(argv) === 'needs-why';
  const jobs = [
    ...Object.values(AGENTS).map((a) => a.args),
    ['restart-copilot', '--resume-only', '--watch', '--open-at-login'],
    ['restart-copilot', '--plugin-updates', '--quiet'],
    ['apple-account', 'mini', '--watch'],
    ['laptop-arrival', 'laptop', '--config', '/tmp/laptop-arrival.json', '--quiet'],
    ['peer', 'watch', 'mini', '--agent', 'ouroboros', '--every', '60', '--ouro', '/tmp/ouro'],
    ['peer', 'watch', 'mini', '--once'],
  ];
  for (const argv of jobs) assert.equal(refusal(argv), null, argv.join(' '));
  for (const argv of [['restart-copilot', '--status'], ['restart-copilot', '--dry-run'], ['restart-copilot', '--dry-run', '--list'], ['apple-account', 'mini', '--status'], ['laptop-arrival', 'mini', '--dry-run'], ['deploy', 'shepherd', '--dry-run']]) assert.equal(needsWhy(argv), false, argv.join(' '));
  for (const argv of [['restart-copilot', '--resume'], ['restart-copilot'], ['apple-account', 'mini', '--now'], ['peer', 'send', 'hi'], ['click', 'mini', '1', '2'], ['deploy', 'housesitter']]) assert.equal(needsWhy(argv), true, argv.join(' '));
});

// One call per verb, written the way a launchd plist, Shepherd, peer-watch or Ouroboros writes it: the kit must still
// read its words and flags as the verb's code expects (bin/housesitter.mjs reads `opt`, then the words in order).
const WHY = ['--why', 'Riley-asked'];
const VERBS = [
  ['demo night', 'demo', { name: 'night' }],
  ['adopt mini --address 10.0.0.5 --heartbeat https://gist.github.com/x --notify ntfy --dry-run', 'adopt', { mac: 'mini', address: '10.0.0.5', heartbeat: 'https://gist.github.com/x', notify: 'ntfy', 'dry-run': true }],
  ['secret mini kvm-admin', 'secret', { mac: 'mini', kind: 'kvm-admin' }],
  ['apple-account mini --watch', 'apple-account', { mac: 'mini', watch: true }],
  ['proof mini --record /tmp/proof --minutes 5 --all-frames', 'proof', { mac: 'mini', record: '/tmp/proof', minutes: '5', 'all-frames': true }],
  [`plug mini adopt 10.0.0.9 ${WHY.join(' ')}`, 'plug', { mac: 'mini', action: 'adopt', ip: '10.0.0.9' }],
  ['doctor mini --private --json', 'doctor', { mac: 'mini', private: true }],
  ['status mini', 'status', { mac: 'mini' }],
  ['look mini --plain', 'look', { mac: 'mini', plain: true }],
  ['screenshot mini --out shot.jpg --max-width 800', 'screenshot', { mac: 'mini', out: 'shot.jpg', 'max-width': '800' }],
  [`click mini 10 20 --right --double ${WHY.join(' ')}`, 'click', { mac: 'mini', x: '10', y: '20', right: true, double: true }],
  [`type mini hello world ${WHY.join(' ')}`, 'type', { mac: 'mini', text: 'hello world' }],
  [`key mini cmd+space ${WHY.join(' ')}`, 'key', { mac: 'mini', combo: 'cmd+space' }],
  [`scroll mini down 5 ${WHY.join(' ')}`, 'scroll', { mac: 'mini', direction: 'down', amount: '5' }],
  [`computer mini {"action":"screenshot"} ${WHY.join(' ')}`, 'computer', { mac: 'mini', computer_action: '{"action":"screenshot"}' }],
  [`unlock mini ${WHY.join(' ')}`, 'unlock', { mac: 'mini' }],
  [`power-cycle mini --attended ${WHY.join(' ')}`, 'power-cycle', { mac: 'mini', attended: true }],
  [`power-on mini ${WHY.join(' ')}`, 'power-on', { mac: 'mini' }],
  [`want-desktop mini --minutes 10 ${WHY.join(' ')}`, 'want-desktop', { mac: 'mini', minutes: '10' }],
  ['watch-kvm mini --install --silent-min 20', 'watch-kvm', { mac: 'mini', install: true, 'silent-min': '20' }],
  [`alert-test mini ${WHY.join(' ')}`, 'alert-test', { mac: 'mini' }],
  ['learn-prompt mini --i-see-the-field --grid 0.48 0.87', 'learn-prompt', { mac: 'mini', 'i-see-the-field': true, grid: true, x: '0.48', y: '0.87' }],
  ['forget mini --yes', 'forget', { mac: 'mini', yes: true }],
  ['ls mini', 'ls', { mac: 'mini' }],
  [`do mini press_key {"key":"a"} ${WHY.join(' ')}`, 'do', { mac: 'mini', action: 'press_key', input: '{"key":"a"}' }],
  [`peer send hello there ${WHY.join(' ')}`, 'peer send', { text: 'hello there' }],
  ['peer inbox', 'peer inbox', {}],
  [`peer flush mini --now ${WHY.join(' ')}`, 'peer flush', { mac: 'mini', now: true }],
  ['peer watch mini --agent ouroboros --every 60 --ouro /tmp/ouro', 'peer watch', { mac: 'mini', agent: 'ouroboros', every: '60', ouro: '/tmp/ouro' }],
  [`peer drill gist outage --minutes 60 ${WHY.join(' ')}`, 'peer drill', { label: 'gist outage', minutes: '60' }],
  [`peer authorize mini --by Ari ${WHY.join(' ')}`, 'peer authorize', { mac: 'mini', by: 'Ari' }],
  ['restart-copilot --resume-only --watch --also Foo --also Bar --skip Baz --heartbeat --mac mini --hackamore {"a":1}', 'restart-copilot', { 'resume-only': true, watch: true, also: ['Foo', 'Bar'], skip: ['Baz'], heartbeat: true, mac: 'mini', hackamore: '{"a":1}' }],
  [`deploy shepherd --ref v0.3.1 --clone /tmp/c ${WHY.join(' ')}`, 'deploy', { name: 'shepherd', ref: 'v0.3.1', clone: '/tmp/c' }],
  ['hold --quiet', 'hold', { quiet: true }],
  ['steer --list', 'steer', { list: true }],
  ['laptop-arrival laptop --config /tmp/l.json --quiet', 'laptop-arrival', { mac: 'laptop', config: '/tmp/l.json', quiet: true }],
  ['fleet --stale-min 15 --disk-floor-gb 20 --always-on mini,studio', 'fleet', { 'stale-min': '15', 'disk-floor-gb': '20', 'always-on': 'mini,studio' }],
  [`fleet run laptop runner --wait 60 ${WHY.join(' ')}`, 'fleet run', { host: 'laptop', step: 'runner', wait: '60' }],
  ['tailnet-policy', 'tailnet-policy', {}],
  ['version', 'version', {}],
];

test('every verb\'s arguments still parse into the words and flags its code reads', async () => {
  const { parseCall, COMMAND_WORDS } = await import('../src/cli-table.mjs');
  assert.deepEqual(VERBS.map((v) => v[1]).sort(), [...COMMAND_WORDS].sort());
  for (const [line, command, want] of VERBS) {
    const call = parseCall(line.split(' '));
    assert.equal(call.command.name, command, line);
    assert.deepEqual(call.input, { ...call.input, ...want }, line);
  }
});
