// Stage Replay API safety tests. Nothing here can start a model run: every case is either
// rejected before a process is spawned or hits a fake eval dir with no engine binary.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withServer(env, fn) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn('node', ['server/index.mjs'], { cwd: root, env: { ...process.env, PIPEOPS_SERVER_PORT: String(port), ...env } });
  try {
    for (let i = 0; i < 50; i++) {
      if (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const base = `http://127.0.0.1:${port}`;
    await fn({
      get: (p) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() })),
      post: (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })),
    });
  } finally { proc.kill(); }
}

/** A fake eval dir: one snapshot step, one variant whose engine binary does NOT exist. */
async function fakeEval() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pipeops-eval-'));
  await mkdir(path.join(dir, 'snapshots/snap1/steps/04-p1-workflow-review'), { recursive: true });
  await writeFile(path.join(dir, 'snapshots/snap1/snapshot.json'), JSON.stringify({ variant: { name: 'v' }, data: { suite: 's', seed: 1 } }));
  await writeFile(path.join(dir, 'snapshots/snap1/steps/04-p1-workflow-review/step.json'), '{}');
  await mkdir(path.join(dir, 'variants'));
  await writeFile(path.join(dir, 'variants/v.json'), JSON.stringify({ name: 'v', binary: '.engines/nope/screenpipe' }));
  return dir;
}

test('stage API rejects bad input before spawning anything', async () => {
  const dir = await fakeEval();
  const good = { step: 'snapshots/snap1/steps/04-p1-workflow-review', variant: 'variants/v.json', task: 'workflow-review', repeat: 1 };
  await withServer({ PIPEOPS_EVAL_DIR: dir }, async ({ post }) => {
    for (const [why, patch] of [
      ['missing fields', { step: undefined }],
      ['unknown step', { step: 'snapshots/snap1/steps/99-nope' }],
      ['path traversal in step', { step: 'snapshots/../steps/04-p1-workflow-review' }],
      ['flag injection as step', { step: '--help' }],
      ['unknown variant', { variant: 'variants/missing.json' }],
      ['traversal in variant', { variant: 'variants/../variants/v.json' }],
      ['unknown task', { task: 'rm -rf' }],
      ['repeat out of range', { repeat: 50 }],
    ]) {
      const r = await post('/api/wfeval/stage', { ...good, ...patch });
      assert.equal(r.status, 400, why);
      assert.ok(typeof r.body.error === 'string' && !/Traceback/.test(r.body.error), why);
    }
    // valid request, but the variant's engine isn't built -> a clear 409 with the setup command, no run
    const r = await post('/api/wfeval/stage', good);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /isn't built.*setup-engine\.sh v/);
  });
  await rm(dir, { recursive: true });
});

test('snapshots/variants endpoints: discovery, engineReady, and the empty (no snapshots) state', async () => {
  const dir = await fakeEval();
  await withServer({ PIPEOPS_EVAL_DIR: dir }, async ({ get }) => {
    const snaps = (await get('/api/snapshots')).body;
    assert.deepEqual(snaps[0].steps, [{ step: '04-p1-workflow-review', phase: 1, task: 'workflow-review' }]);
    const v = (await get('/api/variants')).body[0];
    assert.equal(v.engineReady, false);
    assert.equal(v.setup, './setup-engine.sh v');
  });
  const empty = await mkdtemp(path.join(os.tmpdir(), 'pipeops-eval-'));
  await withServer({ PIPEOPS_EVAL_DIR: empty }, async ({ get }) => {
    assert.deepEqual((await get('/api/snapshots')).body, []); // Demo-only machine: unavailable, not an error
  });
  await rm(dir, { recursive: true }); await rm(empty, { recursive: true });
});

test('stage API: --through is validated before anything is spawned', async () => {
  const dir = await fakeEval();
  const good = { step: 'snapshots/snap1/steps/04-p1-workflow-review', variant: 'variants/v.json', repeat: 1 };
  await mkdir(path.join(dir, 'snapshots/snap1/steps/03-p1-workflow-deepen'), { recursive: true });
  await writeFile(path.join(dir, 'snapshots/snap1/steps/03-p1-workflow-deepen/step.json'), '{}');
  await withServer({ PIPEOPS_EVAL_DIR: dir }, async ({ post }) => {
    for (const [why, body] of [
      ['unknown agent', { ...good, through: 'rm -rf' }],
      ['flag injection', { ...good, through: '--help' }],
      ['not after the step (review → review)', { ...good, through: 'workflow-review' }],
      ['before the step (review → deepen)', { ...good, through: 'workflow-deepen' }],
    ]) {
      const r = await post('/api/wfeval/stage', body);
      assert.equal(r.status, 400, why);
    }
    // deepen → review is valid; the engine isn't built, so it stops at 409 without running
    const r = await post('/api/wfeval/stage', { ...good, step: 'snapshots/snap1/steps/03-p1-workflow-deepen', through: 'workflow-review' });
    assert.equal(r.status, 409);
  });
  await rm(dir, { recursive: true });
});

test('stage-results endpoint lists graded stage runs and is empty on a demo-only machine', async () => {
  const dir = await fakeEval();
  const sd = path.join(dir, 'runs/20261018T010000Z-v-stage-review-r1');
  await mkdir(sd, { recursive: true });
  await writeFile(path.join(sd, 'run.json'), JSON.stringify({ kind: 'stage', variant: { name: 'v' } }));
  await writeFile(path.join(sd, 'stage.json'), '{}');
  await writeFile(path.join(sd, 'results.jsonl'), JSON.stringify({ variant: 'v', stage: 'workflow-review', view: 'catalog', status: 'done',
    passed: 11, scored: 11, seconds: 140, usage: { requests: 18 } }) + '\n');
  await withServer({ PIPEOPS_EVAL_DIR: dir }, async ({ get }) => {
    const list = (await get('/api/stage-results')).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].requests, 18);
    assert.deepEqual(list[0].tasks, ['workflow-review']);
  });
  const empty = await mkdtemp(path.join(os.tmpdir(), 'pipeops-eval-'));
  await withServer({ PIPEOPS_EVAL_DIR: empty }, async ({ get }) => {
    assert.deepEqual((await get('/api/stage-results')).body, []);
  });
  await rm(dir, { recursive: true }); await rm(empty, { recursive: true });
});
