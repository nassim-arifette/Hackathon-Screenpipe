#!/usr/bin/env node
// Usage: npm run import-judge -- <judgeDir> <baselineRunId> <variantRunId>
// Turns an LLM-judge result folder (eval/judge/: key.json, results/jNN.json, build.py) into the
// small review file Compare shows next to the automatic checks:
//   demo-data/reviews/<baselineRunId>__<variantRunId>.json
// It refuses unless the judge's own build.py names exactly these two runs, every judgment in
// key.json has a result file, and every judgment has a preference. The file keeps verdicts and
// scores, never the judges' free text (it quotes screen content and names local paths), and the
// sha256 of every input, so anyone holding the folder can check the numbers.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const METRICS = ['faithful', 'procedure', 'exceptions', 'rule_change', 'usable', 'calibration', 'numbers', 'clarity'];
const CORRECTNESS = METRICS.slice(0, 4);
const here = path.dirname(fileURLToPath(import.meta.url));
const [dirArg, baselineId, variantId] = process.argv.slice(2);
if (!dirArg || !baselineId || !variantId) {
  console.error('usage: npm run import-judge -- <judgeDir> <baselineRunId> <variantRunId>');
  process.exit(2);
}
const fail = (msg) => { console.error(`REFUSING to write — ${msg}`); process.exit(1); };
const dir = path.resolve(dirArg);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const mean = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100 : null);

// 1. The judge folder is for these two runs (the first RUNS block of build.py is the main pair).
const build = await readFile(path.join(dir, 'build.py'), 'utf8').catch(() => fail('no build.py in the judge folder'));
const runsBlock = build.slice(build.indexOf('RUNS = {'), build.indexOf('OUT, KEY'));
if (!runsBlock.includes(baselineId) || !runsBlock.includes(variantId)) fail(`build.py does not name both runs (${baselineId}, ${variantId})`);

// 2. Every judgment is present, answered and unblinded with the key.
const keyBuf = await readFile(path.join(dir, 'key.json'));
const key = JSON.parse(keyBuf);
const inputs = { 'key.json': sha(keyBuf), 'build.py': sha(build) };
const judgments = [];
for (const [id, k] of Object.entries(key).sort()) {
  const buf = await readFile(path.join(dir, 'results', `${id}.json`)).catch(() => fail(`results/${id}.json is missing`));
  inputs[`results/${id}.json`] = sha(buf);
  const r = JSON.parse(buf);
  if (!['X', 'Y', 'tie'].includes(r.preference)) fail(`${id}: no preference`);
  const side = { X: k.X, Y: k.Y, tie: 'tie' };
  const label = (s) => (s === 'base' ? 'baseline' : s === 'stack' ? 'variant' : s);
  const score = (L, m) => r.scores?.[L]?.[m]?.score ?? null;
  judgments.push({
    id, pair: k.pair, phase: k.phase, job: k.job, order: k.order,
    preferred: label(side[r.preference]), strength: r.strength ?? null,
    scores: {
      baseline: Object.fromEntries(METRICS.map((m) => [m, score(k.X === 'base' ? 'X' : 'Y', m)])),
      variant: Object.fromEntries(METRICS.map((m) => [m, score(k.X === 'stack' ? 'X' : 'Y', m)])),
    },
  });
}

// 3. Per pair: the verdict counts only when both orders agree.
const byPair = new Map();
for (const j of judgments) byPair.set(j.pair, [...(byPair.get(j.pair) ?? []), j]);
const pairs = [...byPair.entries()].map(([pair, js]) => {
  const prefs = new Set(js.map((j) => j.preferred));
  const verdict = js.length === 2 && prefs.size === 1 ? [...prefs][0] : 'inconsistent';
  const side = (s) => mean(js.flatMap((j) => CORRECTNESS.map((m) => j.scores[s][m]).filter((v) => v !== null)));
  return {
    pair, phase: js[0].phase, job: js[0].job, verdict,
    strengths: js.map((j) => j.strength),
    correctness: { baseline: side('baseline'), variant: side('variant') },
  };
}).sort((a, b) => a.phase - b.phase || a.job.localeCompare(b.job));

const means = Object.fromEntries(METRICS.map((m) => {
  const b = judgments.map((j) => j.scores.baseline[m]).filter((v) => v !== null);
  const v = judgments.map((j) => j.scores.variant[m]).filter((x) => x !== null);
  return [m, { baseline: mean(b), variant: mean(v), n: Math.min(b.length, v.length) }];
}));

const doc = {
  format: 'pipeops.review',
  formatVersion: 1,
  kind: 'llm-judge',
  baselineRunId: baselineId,
  variantRunId: variantId,
  judgments: judgments.length,
  pairs,
  summary: Object.fromEntries(['baseline', 'variant', 'inconsistent'].map((v) => [v, pairs.filter((p) => p.verdict === v).length])),
  means,
  method: {
    // Not checkable from the files; this is how eval/EXPERIMENTS.md ("LLM judge") describes it.
    describedIn: 'eval/EXPERIMENTS.md · LLM judge',
    note: 'Each workflow document of the pair was judged twice, with the two documents swapped; a preference counts only when both orders agree. Judges are the same model family that wrote both documents.',
  },
  source: { generatedBy: 'pipeops/scripts/import-judge.mjs', sha256: inputs },
};

const out = path.join(here, '..', 'demo-data', 'reviews', `${baselineId}__${variantId}.json`);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${path.relative(process.cwd(), out)}\n  ${judgments.length} judgments, ${pairs.length} pairs: ${JSON.stringify(doc.summary)}`);
