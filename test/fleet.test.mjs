// The fleet view: one row per Mac from the health records in the fleet gist, with what is wrong with each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beatsFromGist, fleetRows, problems, readFleet, renderFleet } from '../src/fleet.mjs';

const BIN = fileURLToPath(new URL('../bin/housesitter.mjs', import.meta.url));
const scratchRoot = path.join(fileURLToPath(new URL('..', import.meta.url)), '.scratch');
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, 'fleet-'));

const NOW = Date.parse('2026-11-14T20:00:00Z');
const rec = (machine, at, extra = {}) => ({ machine, at, uptime_min: 600, disk: { free_gb: 300 }, power: { caffeinate: true }, hub: { connected: true }, tokens: { az: true, gh_personal: true }, net: { default_if: 'en0' }, alerts: [], usb: { missing: [] }, thermal: { speed_limit: null, warning: false }, ...extra });
const gist = (files) => ({ files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { content: typeof content === 'string' ? content : JSON.stringify(content) }])) });

test('a healthy record has no problems, and every kind of trouble is named', () => {
  assert.deepEqual(problems(rec('a', '2026-11-14T19:59:00Z')), []);
  const sick = rec('mini', '2026-11-14T19:59:00Z', {
    panic: { this_boot: true, latest: 'panic-1.ips' }, hub: { connected: false }, drains: [{ name: 'issues', ok: false, loaded: false }, { name: 'prs', ok: false, loaded: true, detectors: 2 }],
    disk: { free_gb: 12 }, power: { caffeinate: false }, thermal: { speed_limit: 60 }, tokens: { az: false, gh_personal: false },
    usb: { missing: [{ name: 'Webcam', why: ['not on USB'] }, { name: 'Mic', why: [] }] }, net: { default_if: null }, alerts: [{ owner: 'SecurityAgent' }],
  });
  const text = problems(sick, { alwaysOn: ['mini'] }).join('\n');
  for (const part of ['kernel panic (panic-1.ips)', 'agent hub not connected', 'drain issues: not loaded', 'drain prs: 2 detectors', 'disk 12 GB free, below 20 GB', 'no caffeinate assertion', 'CPU speed limit 60%', 'az is signed out', 'gh is signed out', '2 USB devices missing: Webcam (not on USB); Mic', 'no network route', '1 system alert waiting']) assert.match(text, new RegExp(part.replace(/[()]/g, '\\$&')), part);
  assert.equal(problems(sick, { diskFloorGb: 10 }).some((p) => p.startsWith('disk')), false, 'the floor is a setting');
  assert.equal(problems(sick).some((p) => p.includes('caffeinate')), false, 'only a Mac named as always-on must stay awake');
});

test('only health records count, and a stale or timeless one is a problem of its own', () => {
  const beats = beatsFromGist(gist({
    'mini.json': rec('mini', '2026-11-14T19:50:00Z'), 'laptop.json': rec('laptop', '2026-11-13T19:00:00Z'), 'bad.json': '{half', 'README.md': 'notes',
    'mini.quota.txt': 'quota', 'housesitter.agent.json': { status: 'ok' }, 'odd.json': rec('odd', 'not a time'),
  }));
  assert.deepEqual(Object.keys(beats).sort(), ['laptop', 'mini', 'odd']);
  const rows = fleetRows(beats, { now: NOW });
  assert.deepEqual(rows.map((r) => [r.name, r.age_min, r.stale, r.healthy]), [['laptop', 1500, true, false], ['mini', 10, false, true], ['odd', null, true, false]]);
  assert.match(rows[0].issues[0], /last record 1500 min old/);
  assert.match(rows[2].issues[0], /no usable time/);
  assert.equal(fleetRows(beats, { now: NOW, staleMin: 5 }).find((r) => r.name === 'mini').stale, true, 'the stale limit is a setting');
});

test('the text view says healthy, lists accounts and issues, and says when the gist holds nothing', () => {
  const rows = fleetRows(beatsFromGist(gist({ 'mini.json': rec('mini', '2026-11-14T19:50:00Z', { app_accounts: ['a@github.com'], screen: { locked: false, idle_sec: 9 } }), 'laptop.json': rec('laptop', '2026-11-14T19:50:00Z', { hub: { connected: false } }) })), { now: NOW });
  const lines = renderFleet(rows);
  assert.match(lines[0], /^● laptop\s+record 10 min ago/);
  assert.equal(lines[1], '    ⚠ agent hub not connected');
  assert.match(lines[2], /^○ mini\s+record 10 min ago · up 10 h · disk 300 GB free · screen unlocked, idle 9 s/);
  assert.deepEqual(lines.slice(3), ['    app accounts: a@github.com', '    healthy']);
  assert.match(renderFleet([])[0], /No health records/);
});

test('the gist is read with gh\'s token for the configured account and its records are returned', async () => {
  const seen = [];
  const fetchFn = async (url, init) => { seen.push([url, init.headers.Authorization]); return { status: 200, headers: new Headers({ etag: 'e' }), json: async () => gist({ 'mini.json': rec('mini', '2026-11-14T19:50:00Z') }) }; };
  const beats = await readFleet({ gistId: 'abc123', token: 'tok', fetchFn });
  assert.deepEqual(Object.keys(beats), ['mini']);
  assert.deepEqual(seen, [['https://api.github.com/gists/abc123', 'Bearer tok']]);
  await assert.rejects(readFleet({ gistId: 'abc123', token: 'tok', fetchFn: async () => ({ status: 404, headers: new Headers(), json: async () => ({ message: 'Not Found' }) }) }), /HTTP 404: Not Found/);
});

test('housesitter fleet reads a saved gist, exits 1 when anything is wrong, and says how to look further when it cannot read', () => {
  const file = path.join(scratch, 'gist.json');
  fs.writeFileSync(file, JSON.stringify(gist({ 'mini.json': rec('mini', new Date(Date.now() - 60000).toISOString()) })));
  const ok = spawnSync(process.execPath, [BIN, 'fleet', '--from', file], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /○ mini\s+record 1 min ago/);
  const sick = spawnSync(process.execPath, [BIN, 'fleet', '--from', file, '--disk-floor-gb', '999', '--json'], { encoding: 'utf8' });
  assert.equal(sick.status, 1);
  assert.match(JSON.parse(sick.stdout).rows[0].issues[0], /disk 300 GB free, below 999 GB/);
  const missing = spawnSync(process.execPath, [BIN, 'fleet', '--from', path.join(scratch, 'none.json')], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /could not read the fleet's health records.*gh auth status.*--from/s);
});
