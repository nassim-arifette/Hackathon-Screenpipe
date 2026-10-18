// Hosted (Vercel) PipeOps API: read-only, serves only the bundled demo runs in demo-data/.
// Local runs, snapshots and live wfeval runs need the local bridge (server/index.mjs).

import express from 'express';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleFromRuns } from '../server/convert.mjs';
import { conditionsKey, portableToRawRun, readPortableFile, validatePortable } from '../server/portable.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = path.join(__dirname, '..', 'demo-data');
const HOSTED = 'This hosted PipeOps is read-only (demo runs only). Run it locally to use eval runs, snapshots and live wfeval.';
const BUILTIN_SUITES = [
  { name: 'receipts', builtin: true, description: 'Receipt filing, an email job, a one-off printer setup, noise; 11 checks over 3 phases' },
  { name: 'busy', builtin: true, description: 'Five jobs including look-alikes of each other, two one-offs, noise in the same apps' },
];

async function readDemoRuns() {
  const files = (await readdir(DEMO_DIR).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
  const runs = [];
  const problems = [];
  for (const f of files) {
    try {
      const doc = await readPortableFile(path.join(DEMO_DIR, f));
      const errs = validatePortable(doc, { fileName: f });
      if (errs.length) problems.push({ file: f, errors: errs });
      else runs.push(doc);
    } catch (e) {
      problems.push({ file: f, errors: [String(e.message ?? e)] });
    }
  }
  return { runs, problems };
}

const app = express();

app.get('/api/health', (_req, res) => res.json({ ok: true, hosted: true }));
app.get('/api/runs', (_req, res) => res.json([]));
app.get('/api/variants', (_req, res) => res.json([]));
app.get('/api/snapshots', (_req, res) => res.json([]));
app.get('/api/suites', (_req, res) => res.json(BUILTIN_SUITES));
app.get('/api/stage-runs', (_req, res) => res.json([]));
app.get('/api/stage-runs/regraded', (_req, res) => res.json({}));
app.get('/api/stage-results', (_req, res) => res.json([]));
app.get('/api/wfeval/status', (_req, res) => res.json({ running: false, runId: null, error: null }));

app.get('/api/demo-runs', async (_req, res) => {
  const { runs } = await readDemoRuns();
  res.json(
    runs
      .map((d) => ({
        id: d.run.id,
        variant: d.provenance.variant.name,
        suite: d.conditions.suite,
        seed: d.conditions.seed,
        phases: d.conditions.phases,
        conditions: conditionsKey(d.conditions),
        startedAt: d.run.startedAt,
        finishedAt: d.run.finishedAt,
        qualityPassed: d.metrics.qualityPassed,
        qualityTotal: d.metrics.qualityTotal,
        modelRequests: d.metrics.modelRequests,
        runtimeSeconds: d.metrics.runtimeSeconds,
      }))
      .sort((a, b) => (a.id < b.id ? 1 : -1)),
  );
});

app.get('/api/demo-runs/problems', async (_req, res) => res.json((await readDemoRuns()).problems));

app.get('/api/demo-experiment', async (req, res) => {
  const baselineId = req.query.baseline;
  const variantId = req.query.variant && req.query.variant !== baselineId ? req.query.variant : null;
  if (!baselineId) return res.status(400).json({ error: 'missing ?baseline=<runId>' });
  const { runs } = await readDemoRuns();
  const base = runs.find((d) => d.run.id === baselineId);
  const variant = variantId ? runs.find((d) => d.run.id === variantId) : null;
  if (!base || (variantId && !variant)) return res.status(404).json({ error: 'demo run not found' });
  if (variant && conditionsKey(base.conditions) !== conditionsKey(variant.conditions)) {
    return res.status(400).json({ error: 'these runs used different test conditions (suite, seed, phases or data) and cannot be compared' });
  }
  res.json(
    bundleFromRuns({
      baseRun: portableToRawRun(base, 'baseline'),
      varRun: portableToRawRun(variant ?? base, 'variant'),
      hasVariant: Boolean(variant),
      suite: base.conditions.suite,
      source: {
        kind: 'artifact',
        file: `pipeops/demo-data/${base.run.id}.json`,
        note: 'Bundled demo run (portable pipeops.run format, sanitized). Per-stage runtime is the summed agent execution time recorded at export.',
      },
    }),
  );
});

app.all('/api/*', (_req, res) => res.status(503).json({ error: HOSTED }));

export default app;
