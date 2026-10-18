// Recorded stage runs are listed separately from full runs, with failures flagged, not dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listRuns, listStageRuns } from '../server/convert.mjs';

const row = (over = {}, usage = {}) => ({
  variant: 'v', stage: 'workflow-review', snapshot: 'snap1/04-p1-workflow-review', status: 'done', passed: 11, scored: 11, seconds: 152.4,
  usage: { requests: 19, input: 5, cacheRead: 6, cacheWrite: 0, output: 7, source: 'request_log', workspace: { failed: 4 }, ...usage }, ...over,
});

async function runDir(root, id, r) {
  await mkdir(path.join(root, id), { recursive: true });
  await writeFile(path.join(root, id, 'results.jsonl'), JSON.stringify(r) + '\n');
}

test('stage runs are listed with real numbers, missing data stays null, failed runs are flagged', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pipeops-'));
  await runDir(tmp, '2-good', row());
  await runDir(tmp, '1-old', row({}, { workspace: undefined })); // predates failed-call logging
  await runDir(tmp, '3-failed', row({}, { requests: 0, source: 'pipe_logs' })); // harness failure
  await runDir(tmp, '4-full', { variant: 'v', suite: 's', seed: 1, phase: 1, status: 'graded', passed: 1, scored: 1, seconds: 1, usage: { requests: 1 } });
  const runs = await listStageRuns(tmp, ['2-good', '1-old', '3-failed', '4-full', 'not-a-run']);
  assert.deepEqual(runs.map((r) => r.id), ['1-old', '2-good', '3-failed']); // full run and junk are not stage runs
  const good = runs.find((r) => r.id === '2-good');
  assert.equal(good.requests, 19);
  assert.equal(good.failedCalls, 4);
  assert.equal(good.seconds, 152);
  assert.equal(good.snapshot, 'snap1');
  assert.equal(good.usable, true);
  assert.equal(runs.find((r) => r.id === '1-old').failedCalls, null); // not logged is not zero
  assert.equal(runs.find((r) => r.id === '3-failed').usable, false);
  assert.deepEqual(await listRuns(tmp, ['2-good', '3-failed']), []); // never mixed into full-run lists
  await rm(tmp, { recursive: true });
});
