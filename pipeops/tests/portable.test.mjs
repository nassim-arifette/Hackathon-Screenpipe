// Non-LLM tests: exporter, validator, security scan, comparability, and the server's
// Demo Runs / Local Runs endpoints. Run with `npm test`. Never calls a model.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, readFile, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportRun, validatePortable, readPortableFile, portableToRawRun, scanForSecrets, conditionsKey } from '../server/portable.mjs';
import { listRuns, listStageResults, buildExperimentBundle, loadRunArtifacts, toRawRun } from '../server/convert.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoDir = path.join(root, 'demo-data');

/** A minimal but realistic fake run dir (full or stage) built in a temp dir. */
async function fakeRun(runsDir, id, { variant = 'v', kind, seed = 1, sha = 'aa', passed = 1 } = {}) {
  const d = path.join(runsDir, id);
  await mkdir(path.join(d, 'phase1'), { recursive: true });
  const run = { run_id: id, variant: { name: variant, preset: { provider: 'p', model: 'm' } }, variant_file: `variants/${variant}.json`,
    data: { suite: 's', seed, frames: { 1: 5 }, sha256: { 'truth.json': sha } }, started_at: 'a', finished_at: 'b',
    engine: { binary: '/Users/someone/eval/.engines/target/debug/screenpipe', commit: 'abc' }, ...(kind ? { kind } : {}) };
  await writeFile(path.join(d, 'run.json'), JSON.stringify(run));
  const row = kind === 'stage'
    ? { stage: 'review', status: 'graded', phase: 1, passed, scored: 1, seconds: 3, checks: { c1: { pass: true } } }
    : { variant, suite: 's', seed, repeat: 1, phase: 1, status: 'graded', passed, scored: 1, seconds: 3, checks: { c1: { pass: passed === 1 } },
        usage: { requests: 2, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, by_task: { 'workflow-discover': { requests: 2 } } }, workflows_by_job: {} };
  await writeFile(path.join(d, 'results.jsonl'), JSON.stringify(row) + '\n');
  await writeFile(path.join(d, 'truth.json'), JSON.stringify({ checks: [{ id: 'c1', kind: 'published', job: 'j' }], jobs: { j: { expect: 'published', summary: 'Job J' } } }));
  await writeFile(path.join(d, 'engine.log'), 'SECRET sk-abcdefghijklmnop0123');
  await writeFile(path.join(d, 'phase1/executions.json'), JSON.stringify({ 'workflow-discover': [
    { status: 'completed', duration_ms: 90000 }, { status: 'completed', duration_ms: 5 }] }));
  await writeFile(path.join(d, 'phase1/phase.json'), JSON.stringify({ cycle: { notes: { 'workflow-discover': 'Found two jobs. Saved to /Users/someone/x', 'workflow-review': '   ' } } }));
  return d;
}

const demoFiles = (await readdir(demoDir)).filter((f) => f.endsWith('.json'));

test('bundled demo files are valid and include our two real runs', async () => {
  assert.ok(demoFiles.length >= 2);
  for (const f of demoFiles) assert.deepEqual(validatePortable(await readPortableFile(path.join(demoDir, f)), { fileName: f }), [], f);
  const variants = await Promise.all(demoFiles.map(async (f) => (await readPortableFile(path.join(demoDir, f))).provenance.variant.name));
  assert.ok(variants.includes('baseline') && variants.includes('episode-routing'));
});

test('demo files render identically to the Local Runs conversion (modulo disclosed redaction)', async (t) => {
  const runsDir = path.join(root, '..', 'eval', 'runs');
  for (const f of demoFiles) {
    const doc = await readPortableFile(path.join(demoDir, f));
    const art = await loadRunArtifacts(runsDir, doc.run.id).catch(() => null);
    if (!art) { t.diagnostic(`skip ${f}: no local eval/runs copy`); continue; }
    const again = await exportRun(runsDir, doc.run.id);
    assert.deepEqual({ ...again, exportedAt: 0 }, { ...doc, exportedAt: 0 });
  }
});

test('baseline r5 and idle-skip r1 are one comparable pair; their phases add up to the run totals', async () => {
  const docs = await Promise.all(['20261018T020827Z-baseline-receipts-s1-r5', '20261018T020907Z-idle-skip-receipts-s1-r1'].map((id) => readPortableFile(path.join(demoDir, `${id}.json`))));
  const [a, b] = docs;
  assert.notEqual(a.conditions.repeat, b.conditions.repeat); // replicate numbers differ...
  assert.equal(conditionsKey(a.conditions), conditionsKey(b.conditions)); // ...the test they ran does not
  for (const d of docs) {
    assert.equal(d.phases.reduce((s, p) => s + p.requests, 0), d.metrics.modelRequests);
    assert.equal(d.phases.reduce((s, p) => s + p.runtimeSeconds, 0), d.metrics.runtimeSeconds);
  }
  const p3 = (d) => d.phases.find((p) => p.phase === 3);
  assert.equal(p3(a).requests, 56);
  assert.equal(p3(b).requests, 0);
  assert.equal(p3(b).cycleStatus, 'idle');
});

test('export keeps only allowlisted content: no engine log, host paths or secrets', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pipeops-'));
  await fakeRun(tmp, 'r1');
  const doc = await exportRun(tmp, 'r1');
  const text = JSON.stringify(doc);
  assert.ok(!text.includes('sk-abc') && !text.includes('/Users/someone') && !text.includes('.engines'));
  assert.deepEqual(validatePortable(doc, { fileName: 'r1.json' }), []);
  assert.equal(doc.metrics.costUsd, null); // missing data stays null, never invented
  await rm(tmp, { recursive: true });
});

test('per-stage runtime and the agent note come from the run files; nothing is invented', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pipeops-'));
  await fakeRun(tmp, 'r1');
  const doc = await exportRun(tmp, 'r1');
  assert.equal(doc.stages.discover.runtimeSeconds, 90); // summed executions
  assert.match(doc.stages.discover.output, /^Found two jobs\. Saved to \/Users\/<redacted>\/x$/);
  for (const id of ['maintain', 'deepen', 'review']) {
    assert.equal(doc.stages[id].runtimeSeconds, null, id); // no executions -> null, not 0
    assert.equal(doc.stages[id].output, null, id); // blank note -> null
  }
  assert.equal(doc.stages.discover.snapshotId, null);
  await rm(tmp, { recursive: true });
});

test('stage and ungraded runs are refused, never exported as full scores', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pipeops-'));
  await fakeRun(tmp, 'stage1', { kind: 'stage' });
  await assert.rejects(exportRun(tmp, 'stage1'), /stage run, not a full evaluation/);
  await mkdir(path.join(tmp, 'half'), { recursive: true });
  await assert.rejects(exportRun(tmp, 'half'), /cannot read run/);
  assert.deepEqual(await listRuns(tmp, ['stage1']), []); // Local Runs never lists it as a full score
  await rm(tmp, { recursive: true });
});

test('validator rejects bad shape, stage kind, unknown keys, mismatched totals and wrong file name', async () => {
  const good = await readPortableFile(path.join(demoDir, demoFiles[0]));
  const clone = () => structuredClone(good);
  const has = (doc, re, o) => assert.ok(validatePortable(doc, o).some((e) => re.test(e)), re);
  has({ ...clone(), kind: 'stage' }, /kind must be "full"/);
  has({ ...clone(), formatVersion: 2 }, /formatVersion/);
  has({ ...clone(), extra: 1 }, /unexpected top-level key/);
  const m = clone(); m.metrics.qualityPassed += 1; has(m, /qualityPassed/);
  has(clone(), /file name must be/, { fileName: 'other.json' });
  const c = clone(); delete c.conditions.dataSha256; has(c, /dataSha256/);
  assert.ok(validatePortable(null).length);
});

/** A full multi-phase run dir with controllable per-phase requests/seconds, idle churn and
 *  refused-call counts. Same conditions on both sides so buildExperimentBundle will pair them. */
async function multiPhaseRun(runsDir, id, { variant, phases }) {
  const d = path.join(runsDir, id);
  await mkdir(d, { recursive: true });
  const run = { run_id: id, variant: { name: variant, preset: { provider: 'p', model: 'm' } },
    data: { suite: 's', seed: 1, sha256: { 'truth.json': 'aa' } }, started_at: 'a', finished_at: 'b' };
  await writeFile(path.join(d, 'run.json'), JSON.stringify(run));
  const rows = phases.map((p) => ({
    variant, suite: 's', seed: 1, repeat: 1, phase: p.phase, status: 'graded',
    passed: p.passed, scored: p.scored, seconds: p.seconds,
    checks: { c1: { pass: p.passed > 0 } }, workflows_by_job: {},
    ...(p.idleChurn ? { mistakes: { idle_churn: 2 } } : {}),
    usage: { requests: p.requests, agent_runs: p.agentRuns ?? 0,
      ...(p.failed != null ? { workspace: { failed: p.failed } } : {}) },
  }));
  await writeFile(path.join(d, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await writeFile(path.join(d, 'truth.json'), JSON.stringify({ checks: [{ id: 'c1', kind: 'published', job: 'j' }], jobs: { j: { expect: 'published', summary: 'Job J' } } }));
  return d;
}

test('phases: per-phase totals read straight from results rows, idle churn and refused calls flagged', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pipeops-'));
  const phases = [
    { phase: 1, passed: 1, scored: 1, seconds: 300, requests: 57, agentRuns: 12, failed: 2 },
    { phase: 2, passed: 1, scored: 1, seconds: 270, requests: 54, agentRuns: 9, failed: 0 },
    { phase: 3, passed: 1, scored: 1, seconds: 0, requests: 0, agentRuns: 0, idleChurn: true, failed: 0 },
  ];
  await multiPhaseRun(tmp, 'mp', { variant: 'idle-skip', phases });
  const { toRawRun } = await import('../server/convert.mjs');
  const raw = toRawRun('mp', 'idle-skip', 'variant', await loadRunArtifacts(tmp, 'mp'));
  assert.equal(raw.phases.length, 3);
  assert.deepEqual(raw.phases.map((p) => p.requests), [57, 54, 0]);
  assert.ok(raw.phases[2].mistakes.idle_churn > 0);
  assert.equal(raw.phases[0].mistakes, null);
  assert.equal(raw.metrics.failedCalls, 2); // summed over phases
  assert.equal(raw.metrics.modelRequests, 111); // phase totals add up to the run total
  await rm(tmp, { recursive: true, force: true });
});

test('failedCalls is null when no phase carries workspace.failed (run predates the logging)', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pipeops-'));
  await multiPhaseRun(tmp, 'old', { variant: 'baseline', phases: [{ phase: 1, passed: 1, scored: 1, seconds: 3, requests: 5 }] });
  const { toRawRun } = await import('../server/convert.mjs');
  const raw = toRawRun('old', 'baseline', 'baseline', await loadRunArtifacts(tmp, 'old'));
  assert.equal(raw.metrics.failedCalls, null);
  await rm(tmp, { recursive: true, force: true });
});

test('verdict is direction-aware: fewer requests reads as an efficiency gain, more as no improvement', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pipeops-'));
  const base = [{ phase: 1, passed: 1, scored: 1, seconds: 100, requests: 100 }];
  const cheaper = [{ phase: 1, passed: 1, scored: 1, seconds: 60, requests: 50 }];
  await multiPhaseRun(tmp, 'base', { variant: 'baseline', phases: base });
  await multiPhaseRun(tmp, 'cheap', { variant: 'idle-skip', phases: cheaper });
  const win = buildExperimentBundle({
    baselineId: 'base', baselineLabel: 'baseline', baselineArtifacts: await loadRunArtifacts(tmp, 'base'),
    variantId: 'cheap', variantLabel: 'idle-skip', variantArtifacts: await loadRunArtifacts(tmp, 'cheap'),
  });
  assert.match(win.comparison.verdict, /efficiency improved/i);
  assert.match(win.comparison.verdict, /document quality needs further validation/i); // same checks is not the same documents
  assert.match(win.comparison.note, /-50%|−50%/); // relative request drop stated
  const regress = buildExperimentBundle({
    baselineId: 'cheap', baselineLabel: 'idle-skip', baselineArtifacts: await loadRunArtifacts(tmp, 'cheap'),
    variantId: 'base', variantLabel: 'baseline', variantArtifacts: await loadRunArtifacts(tmp, 'base'),
  });
  assert.match(regress.comparison.verdict, /no improvement/i);
  await rm(tmp, { recursive: true, force: true });
});

test('portable round-trips phases and validates their shape; rejects malformed ones', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pipeops-'));
  await multiPhaseRun(tmp, 'rt', { variant: 'idle-skip', phases: [
    { phase: 1, passed: 1, scored: 1, seconds: 300, requests: 57, failed: 1 },
    { phase: 2, passed: 1, scored: 1, seconds: 270, requests: 54, failed: 0 },
  ] });
  const doc = await exportRun(tmp, 'rt');
  assert.equal(doc.run.id, 'rt');
  assert.equal(doc.phases.length, 2);
  assert.equal(doc.metrics.failedCalls, 1);
  assert.deepEqual(validatePortable(doc, { fileName: 'rt.json' }), []);
  // a portable file maps back to a run carrying the phases
  const loaded = portableToRawRun(doc, 'variant');
  assert.equal(loaded.phases.length, 2);
  // malformed: a negative number, a list that does not match conditions.phases, totals that do not add up
  const bad = structuredClone(doc); bad.phases[0].requests = -1;
  assert.ok(validatePortable(bad, { fileName: 'rt.json' }).some((e) => /non-negative/.test(e)));
  const short = structuredClone(doc); short.phases.pop();
  assert.ok(validatePortable(short, { fileName: 'rt.json' }).some((e) => /conditions\.phases/.test(e)));
  const off = structuredClone(doc); off.phases[0].requests += 50;
  assert.ok(validatePortable(off, { fileName: 'rt.json' }).some((e) => /do not add up/.test(e)));
  await rm(tmp, { recursive: true, force: true });
});

test('security scan flags credentials, tokens, host paths and emails', () => {
  for (const bad of ['sk-ant-api03-abcdefghijklmnopqrstu', 'Authorization: Bearer abcdefghijklmnop1234', 'api_key=hunter2hunter2',
    '/Users/alice/Documents/x', '/home/bob/.ssh', 'me@example.com', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig', 'ghp_abcdefghijklmnopqrstuvwx']) {
    assert.ok(scanForSecrets({ a: { b: [bad] } }).length, bad);
  }
  assert.deepEqual(scanForSecrets({ p: '/Users/<redacted>/Documents', h: 'f2343f495408afdae3a4f4fa14fbd796697a9dcaff748002a3631972f4c95b1d' }), []);
});

test('comparability: different seed or data never compares; same conditions do', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pipeops-'));
  await fakeRun(tmp, 'a', { variant: 'baseline' });
  await fakeRun(tmp, 'b', { variant: 'x' });
  await fakeRun(tmp, 'c', { variant: 'x', seed: 2 });
  await fakeRun(tmp, 'd', { variant: 'x', sha: 'bb' });
  const [a, b, c, d] = await Promise.all(['a', 'b', 'c', 'd'].map((i) => loadRunArtifacts(tmp, i)));
  const mk = (x, y, ids) => buildExperimentBundle({ baselineId: ids[0], baselineLabel: 'a', baselineArtifacts: x, variantId: ids[1], variantLabel: 'b', variantArtifacts: y });
  assert.ok(mk(a, b, ['a', 'b']).comparison.verdict);
  assert.throws(() => mk(a, c, ['a', 'c']), /cannot be compared/);
  assert.throws(() => mk(a, d, ['a', 'd']), /cannot be compared/);
  const list = await listRuns(tmp, ['a', 'b', 'c', 'd']);
  const keys = Object.fromEntries(list.map((r) => [r.id, r.conditions]));
  assert.equal(keys.a, keys.b);
  assert.notEqual(keys.a, keys.c);
  assert.notEqual(keys.a, keys.d);
  await rm(tmp, { recursive: true });
});

/* ---- server: Demo Runs work with no eval/runs/, a new valid file appears, invalid is skipped ---- */

async function withServer(env, fn) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn('node', ['server/index.mjs'], { cwd: root, env: { ...process.env, PIPEOPS_SERVER_PORT: String(port), ...env } });
  try {
    for (let i = 0; i < 50; i++) {
      if (await fetch(`http://localhost:${port}/api/health`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await fn((p) => fetch(`http://localhost:${port}${p}`).then(async (r) => ({ status: r.status, body: await r.json() })));
  } finally { proc.kill(); }
}

test('server: Demo Runs work without eval/runs/; new valid files appear; invalid ones are skipped', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pipeops-'));
  const demo = path.join(tmp, 'demo');
  await cp(demoDir, demo, { recursive: true });
  await withServer({ PIPEOPS_RUNS_DIR: path.join(tmp, 'does-not-exist'), PIPEOPS_DEMO_DIR: demo }, async (get) => {
    assert.deepEqual((await get('/api/runs')).body, []); // Local Runs: empty, not an error
    const demos = (await get('/api/demo-runs')).body;
    assert.equal(demos.length, demoFiles.length);
    const base = demos.find((r) => r.variant === 'baseline' && r.phases.length === 1), variant = demos.find((r) => r.variant === 'episode-routing');
    assert.equal(base.conditions, variant.conditions);
    const exp = await get(`/api/demo-experiment?baseline=${base.id}&variant=${variant.id}`);
    assert.equal(exp.status, 200);
    assert.equal(exp.body.runs.length, 2);
    assert.equal(exp.body.runs[0].checks.length, exp.body.runs[0].metrics.qualityTotal);

    // a teammate drops in a new valid file -> appears with no restart
    const doc = await readPortableFile(path.join(demoDir, demoFiles[0]));
    doc.run.id = 'extra-run'; doc.conditions.seed = 99;
    await writeFile(path.join(demo, 'extra-run.json'), JSON.stringify(doc));
    assert.equal((await get('/api/demo-runs')).body.length, demoFiles.length + 1);
    // ...but not comparable with the seed-1 runs
    assert.equal((await get(`/api/demo-experiment?baseline=extra-run&variant=${variant.id}`)).status, 400);

    // an invalid file is skipped and reported, never half-loaded
    await writeFile(path.join(demo, 'bad.json'), JSON.stringify({ ...doc, kind: 'stage' }));
    assert.equal((await get('/api/demo-runs')).body.length, demoFiles.length + 1);
    assert.equal((await get('/api/demo-runs/problems')).body[0].file, 'bad.json');
  });
  await rm(tmp, { recursive: true });
});

test('server: Local Runs still list and load from a runs dir', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pipeops-'));
  await fakeRun(tmp, 'a', { variant: 'baseline' });
  await fakeRun(tmp, 'b', { variant: 'x' });
  await fakeRun(tmp, 'st', { variant: 'x', kind: 'stage' });
  await withServer({ PIPEOPS_RUNS_DIR: tmp }, async (get) => {
    const runs = (await get('/api/runs')).body;
    assert.deepEqual(runs.map((r) => r.id).sort(), ['a', 'b']); // stage run excluded
    assert.equal((await get('/api/experiment?baseline=a&variant=b')).status, 200);
  });
  await rm(tmp, { recursive: true });
});

test('portableToRawRun maps cleanly to the UI shape', async () => {
  const raw = portableToRawRun(await readPortableFile(path.join(demoDir, demoFiles[0])), 'baseline');
  assert.equal(raw.status, 'recorded');
  assert.ok(raw.checks.length && raw.groundTruth.length && raw.generatedWorkflows.length);
  assert.ok(conditionsKey({}) .length);
});

test('eval fields reach the UI: phase cycle, per-check in_stages, and they round-trip the portable format', async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'pipeops-runs-'));
  const id = '20261018T000000Z-v-s-s1-r1';
  const d = await fakeRun(runsDir, id);
  const row = JSON.parse((await readFile(path.join(d, 'results.jsonl'), 'utf8')).trim());
  row.checks.c1.in_stages = false;
  const idle = { ...row, phase: 3, cycle: 'idle', passed: 0, scored: 0, checks: {}, seconds: 0, usage: { ...row.usage, requests: 0 } };
  await writeFile(path.join(d, 'results.jsonl'), [JSON.stringify({ ...row, cycle: 'complete' }), JSON.stringify(idle)].join('\n') + '\n');
  await mkdir(path.join(d, 'phase3'), { recursive: true });
  await writeFile(path.join(d, 'phase3/phase.json'), JSON.stringify({}));
  const run = toRawRun(id, 'v', 'baseline', await loadRunArtifacts(runsDir, id));
  assert.deepEqual(run.phases.map((p) => p.cycleStatus), ['complete', 'idle']);
  assert.equal(run.checks[0].inStages, false);
  const doc = await exportRun(runsDir, id);
  assert.deepEqual(validatePortable(doc), []);
  const back = portableToRawRun(doc, 'variant');
  assert.equal(back.phases[1].cycleStatus, 'idle');
  assert.equal(back.checks[0].inStages, false);
  await rm(runsDir, { recursive: true });
});

test('stage runs are summarised from results.jsonl, apart from full runs', async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'pipeops-runs-'));
  await fakeRun(runsDir, '20261018T000000Z-v-s-s1-r1'); // a full run: not a stage run
  const sd = path.join(runsDir, '20261018T010000Z-clearer-stage-review-04-r1');
  await mkdir(sd, { recursive: true });
  await writeFile(path.join(sd, 'run.json'), JSON.stringify({ kind: 'stage', task: 'workflow-review', variant: { name: 'clearer' }, started_at: 't' }));
  await writeFile(path.join(sd, 'stage.json'), '{}');
  await writeFile(path.join(sd, 'results.jsonl'), JSON.stringify({
    variant: 'clearer', stage: 'workflow-deepen+workflow-review', snapshot: 'snap/03-p1-workflow-deepen', phase: 1, view: 'catalog',
    status: 'done', passed: 11, scored: 11, seconds: 141.6, in_stages: 5, keyword_checks: 6,
    before: { drafts: { score: 1 }, catalog: { score: 0 } }, clipped: { fields: 2, chars: 40, where: {} },
    usage: { requests: 30, output: 13000, workspace: { failed: 1 }, by_task: { 'workflow-deepen': { requests: 12 }, 'workflow-review': { requests: 18 } } },
  }) + '\n');
  await mkdir(path.join(runsDir, '20261018T020000Z-aborted'), { recursive: true }); // no files: skipped
  const list = await listStageResults(runsDir, await readdir(runsDir));
  assert.equal(list.length, 1);
  assert.deepEqual(
    { ...list[0], id: undefined },
    { id: undefined, variant: 'clearer', tasks: ['workflow-deepen', 'workflow-review'], snapshot: 'snap/03-p1-workflow-deepen', phase: 1,
      view: 'catalog', status: 'done', passed: 11, scored: 11, scoreBefore: 0, requests: 30, seconds: 142, output: 13000, failedCalls: 1,
      byTask: { 'workflow-deepen': 12, 'workflow-review': 18 }, clipped: { fields: 2, chars: 40 }, inStages: 5, keywordChecks: 6,
      truth: null, startedAt: 't' },
  );
  await rm(runsDir, { recursive: true });
});
