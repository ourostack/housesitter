// housesitter restart-copilot --grant-softwareupdate: one narrow sudoers rule, checked before and after it is installed,
// with the administrator's password given to sudo on stdin and never in argv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_PATTERN, RULE_FILE, grant, revoke, ruleText } from '../src/sudo-rule.mjs';

const SCRATCH = path.join(path.dirname(new URL(import.meta.url).pathname), '.scratch');
fs.mkdirSync(SCRATCH, { recursive: true });
const SECRET = 'correct horse battery staple';

function fake({ allowed = false, wrong = false, badFile = false } = {}) {
  const calls = [];
  const stage = fs.mkdtempSync(path.join(SCRATCH, 'sr-'));
  return {
    calls, stage,
    password: async () => SECRET,
    run: async (file, argv, o = {}) => {
      calls.push({ file, argv, input: o.input ?? null });
      const sudoed = file === '/usr/bin/sudo';
      if (sudoed && argv[0] === '-n' && argv[1] === '-l') return { code: allowed || calls.some((c) => c.argv.includes('/bin/mv')) ? 0 : 1, stdout: '', stderr: '' };
      if (sudoed && argv[0] === '-n') return { code: 0, stdout: 'Software Update Tool\n\nNo new software available.\n', stderr: '' };
      if (file === '/usr/sbin/visudo') return { code: 0, stdout: 'parsed OK', stderr: '' };
      if (sudoed && wrong) return { code: 1, stdout: '', stderr: 'Sorry, try again.' };
      if (sudoed && badFile && argv.includes('/usr/sbin/visudo')) return { code: 1, stdout: '', stderr: 'syntax error' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

test('the rule names one user and exactly three softwareupdate commands, and nothing else', () => {
  const t = ruleText('arimendelow');
  assert.match(t, /^arimendelow ALL=\(root\) NOPASSWD: \/usr\/sbin\/softwareupdate --list, \/usr\/sbin\/softwareupdate -l, \/usr\/sbin\/softwareupdate --install \* --restart --agree-to-license$/m);
  assert.equal(t.split('\n').filter((l) => l && !l.startsWith('#')).length, 1);
  assert.doesNotMatch(t.split('\n').filter((l) => !l.startsWith('#')).join('\n'), /shutdown|NOPASSWD: ALL/);
  assert.throws(() => ruleText('bad user; ALL'), /not a user name sudoers accepts/);
  assert.deepEqual(INSTALL_PATTERN.slice(0, 2), ['/usr/sbin/softwareupdate', '--install']);
});

test('grant: checked with visudo, installed under a name sudo ignores, checked again, moved into place, proven with sudo -n; the password only on stdin', async () => {
  const d = fake();
  const r = await grant({ user: 'arimendelow', deps: d });
  assert.equal(r.ok, true, r.why);
  const sudos = d.calls.filter((c) => c.file === '/usr/bin/sudo' && c.argv[0] === '-S');
  assert.deepEqual(sudos.map((c) => c.argv[3]), ['/usr/bin/install', '/usr/sbin/visudo', '/bin/mv']);
  assert.ok(sudos[0].argv.includes(`${RULE_FILE}.pending`), 'the first copy has a dot in its name, which sudo skips');
  assert.deepEqual(sudos[2].argv.slice(-2), [`${RULE_FILE}.pending`, RULE_FILE]);
  assert.ok(sudos.every((c) => c.input === `${SECRET}\n`), 'the password goes in on stdin');
  assert.equal(d.calls.some((c) => c.argv.some((a) => String(a).includes(SECRET))), false, 'never in argv');
  assert.equal(d.calls[0].file, '/usr/sbin/visudo', 'the candidate is checked before sudo is used');
  assert.ok(d.calls.some((c) => c.argv[0] === '-n' && c.argv.includes('--list')), 'proven with sudo -n softwareupdate --list');
  assert.equal(fs.existsSync(path.join(d.stage, 'softwareupdate.sudoers')), false, 'the candidate is removed');
  assert.match(r.steps.join(';'), /works/);
});

test('grant: a wrong password or a file visudo rejects leaves nothing behind; an existing grant is left alone; --dry-run touches nothing', async () => {
  const wrong = fake({ wrong: true });
  const a = await grant({ user: 'arimendelow', deps: wrong });
  assert.equal(a.ok, false);
  assert.match(a.why, /wrong password/);
  assert.ok(wrong.calls.some((c) => c.argv.includes('/bin/rm') && c.argv.includes(`${RULE_FILE}.pending`)), 'the pending file is removed');
  assert.equal(wrong.calls.some((c) => c.argv.includes('/bin/mv')), false);
  const bad = fake({ badFile: true });
  const b = await grant({ user: 'arimendelow', deps: bad });
  assert.match(b.why, /visudo rejected the installed file/);
  assert.equal(bad.calls.some((c) => c.argv.includes('/bin/mv')), false, 'a rejected file is never moved into place');
  const have = fake({ allowed: true });
  const c = await grant({ user: 'arimendelow', deps: have });
  assert.equal(c.already, true);
  assert.equal(have.calls.some((x) => x.argv[0] === '-S'), false);
  const dry = fake();
  const dr = await grant({ user: 'arimendelow', deps: dry, dry: true });
  assert.equal(dr.dry_run, true);
  assert.equal(dry.calls.some((x) => x.file === '/usr/bin/sudo'), false);
});

test('grant without a password asks for one rather than guessing; revoke removes the file', async () => {
  const d = fake();
  d.password = async () => null;
  await assert.rejects(() => grant({ user: 'arimendelow', deps: d }), /no administrator password to give sudo/);
  const e = fake();
  const r = await revoke({ deps: e });
  assert.equal(r.ok, true);
  assert.deepEqual(e.calls.at(-1).argv.slice(-2), ['/bin/rm', '-f'].concat([RULE_FILE]).slice(-2));
  assert.equal(e.calls.at(-1).input, `${SECRET}\n`);
});
