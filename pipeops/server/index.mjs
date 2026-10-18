// PipeOps local bridge: serves real wfeval run artifacts to the frontend and can
// trigger a live `wfeval run` + `wfeval grade`, streaming its output to the browser.
//
// Runs only on localhost. Everything here shells out to the user's own eval harness
// on the same machine — nothing is sent anywhere else.

import express from 'express';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleFromRuns, buildExperimentBundle, listRuns, listStageResults, listStageRuns, loadRunArtifacts } from './convert.mjs';
import { conditionsKey, portableToRawRun, readPortableFile, validatePortable } from './portable.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..'); // .../Hackathon-Screenpipe
const EVAL_DIR = process.env.PIPEOPS_EVAL_DIR ?? path.join(REPO_ROOT, 'eval');
const RUNS_DIR = process.env.PIPEOPS_RUNS_DIR ?? path.join(EVAL_DIR, 'runs');
const DEMO_DIR = process.env.PIPEOPS_DEMO_DIR ?? path.join(__dirname, '..', 'demo-data');
const VARIANTS_DIR = path.join(EVAL_DIR, 'variants');
const SNAPSHOTS_DIR = path.join(EVAL_DIR, 'snapshots');
const SUITES_DIR = path.join(EVAL_DIR, 'suites');
// Spawned wfeval processes import the package from eval/src directly. On macOS the editable
// install's .pth file can get the "hidden" flag, which Python 3.13+ ignores ("No module named
// 'wfeval'"); putting src/ on PYTHONPATH makes Stage Replay and runs independent of that.
const PY_ENV = { ...process.env, PYTHONPATH: [path.join(EVAL_DIR, 'src'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
const PORT = process.env.PIPEOPS_SERVER_PORT ? Number(process.env.PIPEOPS_SERVER_PORT) : 8787;

const app = express();
app.use(express.json());

// Only one live run at a time — the harness itself enforces this (one engine per Mac).
let live = null; // { proc, logs: string[], done: boolean, runId: string|null, error: string|null }

app.get('/api/health', (_req, res) => res.json({ ok: true, evalDir: EVAL_DIR }));

app.get('/api/runs', async (_req, res) => {
  try {
    // A fresh clone has no eval/runs/ — that's an empty Local Runs list, not an error.
    const entries = (await readdir(RUNS_DIR, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    res.json(await listRuns(RUNS_DIR, entries));
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

// Recorded stage runs: a file read, no model. Separate from /api/runs on purpose (see listStageRuns).
app.get('/api/stage-runs', async (_req, res) => {
  try {
    const entries = (await readdir(RUNS_DIR, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
    res.json(await listStageRuns(RUNS_DIR, entries));
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

// Stage runs graded again against the suite's CURRENT truth (`wfeval grade --truth`, free: it reads the
// files each run kept, calls no model). A run graded before a truth correction otherwise keeps its old
// score. One Python process per suite and seed; cached, because it takes a few seconds. A run whose
// suite data is not on this machine, or that cannot be graded again, is null: the page then shows the
// score in its own files and says so.
const REGRADE_SCRIPT = [
  'import json, sys',
  'from pathlib import Path',
  'from wfeval.stage import regrade',
  'out = {}',
  'for r in sys.argv[2:]:',
  '    try:',
  '        g = regrade(Path(r), Path(sys.argv[1]))',
  '        out[Path(r).name] = {"passed": g["passed"], "scored": g["scored"], "truth": g["truth"]}',
  '    except Exception:',
  '        out[Path(r).name] = None',
  'print(json.dumps(out))',
].join('\n');
let regradeCache = null; // { key, promise }

app.get('/api/stage-runs/regraded', async (_req, res) => {
  try {
    const entries = (await readdir(RUNS_DIR, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
    const runs = await listStageRuns(RUNS_DIR, entries);
    const groups = new Map();
    for (const r of runs) {
      if (!r.suite || r.seed === null) continue;
      const truth = path.join(EVAL_DIR, 'data', `${r.suite}-s${r.seed}`, 'truth.json');
      if (await exists(truth)) groups.set(truth, [...(groups.get(truth) ?? []), r.id]);
    }
    const key = JSON.stringify([...groups].map(([t, ids]) => [t, ids.length]));
    if (!regradeCache || regradeCache.key !== key) {
      regradeCache = {
        key,
        promise: (async () => {
          const out = {};
          for (const [truth, ids] of groups) {
            const r = await runPython(['run', 'python', '-c', REGRADE_SCRIPT, truth, ...ids.map((id) => path.join(RUNS_DIR, id))]);
            try {
              Object.assign(out, JSON.parse(r.stdout.trim().split('\n').pop()));
            } catch {
              for (const id of ids) out[id] = null;
            }
          }
          return out;
        })(),
      };
    }
    res.json(await regradeCache.promise);
  } catch (e) {
    regradeCache = null;
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

// Demo Runs: portable, sanitized experiment files bundled in pipeops/demo-data/. Every
// request re-reads the directory, so a newly added valid file shows up without a restart.
// Invalid files are skipped (and reported via /api/demo-runs/problems), never half-loaded.
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
  const baseRun = portableToRawRun(base, 'baseline');
  const varRun = portableToRawRun(variant ?? base, 'variant');
  const bundle =
    bundleFromRuns({
      baseRun,
      varRun,
      hasVariant: Boolean(variant),
      suite: base.conditions.suite,
      source: {
        kind: 'artifact',
        file: `pipeops/demo-data/${base.run.id}.json`,
        note: 'Bundled demo run (portable pipeops.run format, sanitized). Per-stage runtime is the summed agent execution time recorded at export.',
      },
    });
  if (variant) bundle.comparison.review = await readReview(base.run.id, variant.run.id);
  res.json(bundle);
});

// An independent review (LLM judge) of this exact pair, imported with `npm run import-judge`.
// Shown only when the file exists and names these two runs; otherwise there is simply no review.
async function readReview(baselineId, variantId) {
  try {
    const doc = JSON.parse(await readFile(path.join(DEMO_DIR, 'reviews', `${baselineId}__${variantId}.json`), 'utf8'));
    const ok = doc.format === 'pipeops.review' && doc.baselineRunId === baselineId && doc.variantRunId === variantId && Array.isArray(doc.pairs) && doc.summary;
    return ok ? doc : null;
  } catch {
    return null;
  }
}

app.get('/api/variants', async (_req, res) => {
  try {
    const files = (await readdir(VARIANTS_DIR)).filter((f) => f.endsWith('.json'));
    const variants = await Promise.all(
      files.map(async (f) => {
        const v = JSON.parse(await readFile(path.join(VARIANTS_DIR, f), 'utf8'));
        // A variant whose engine binary isn't built here can't be run (see setup-engine.sh).
        const engineReady = await access(path.join(EVAL_DIR, v.binary ?? '')).then(() => true, () => false);
        return { file: `variants/${f}`, name: v.name, description: v.description ?? null, engineReady, setup: engineReady ? null : `./setup-engine.sh ${v.name}` };
      }),
    );
    res.json(variants);
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

// Suites. Two are built into the harness (stories.py); anything in eval/suites/<name>.json
// is a developer's own (wfeval/custom.py). The harness is the validator: a saved suite is
// rendered once into a temp dir, and the file only stays if that works.
const BUILTIN_SUITES = [
  { name: 'receipts', description: 'Receipt filing, an email job, a one-off printer setup, noise; 11 checks over 3 phases' },
  { name: 'busy', description: 'Five jobs including look-alikes of each other, two one-offs, noise in the same apps' },
];
const SUITE_NAME = /^[a-z][a-z0-9-]{0,30}$/;

app.get('/api/suites', async (_req, res) => {
  const files = (await readdir(SUITES_DIR).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
  const custom = [];
  for (const f of files) {
    const name = f.replace(/\.json$/, '');
    try {
      const spec = JSON.parse(await readFile(path.join(SUITES_DIR, f), 'utf8'));
      custom.push({ name, builtin: false, description: spec.description ?? '', jobs: Object.keys(spec.jobs ?? {}).length, checks: (spec.checks ?? []).length });
    } catch {
      custom.push({ name, builtin: false, description: '', jobs: 0, checks: 0, broken: true });
    }
  }
  res.json([...BUILTIN_SUITES.map((s) => ({ ...s, builtin: true })), ...custom]);
});

app.get('/api/suites/:name', async (req, res) => {
  if (!SUITE_NAME.test(req.params.name)) return res.status(400).json({ error: 'bad suite name' });
  try {
    res.json(JSON.parse(await readFile(path.join(SUITES_DIR, `${req.params.name}.json`), 'utf8')));
  } catch {
    res.status(404).json({ error: 'no such custom suite' });
  }
});

app.put('/api/suites/:name', async (req, res) => {
  const { name } = req.params;
  if (!SUITE_NAME.test(name)) return res.status(400).json({ error: 'Name: lower case letters, digits and "-", starting with a letter.' });
  if (BUILTIN_SUITES.some((s) => s.name === name)) return res.status(400).json({ error: `"${name}" is a built-in suite; choose another name.` });
  const spec = req.body?.spec;
  if (!spec || typeof spec !== 'object') return res.status(400).json({ error: 'missing spec' });
  const file = path.join(SUITES_DIR, `${name}.json`);
  const previous = await readFile(file, 'utf8').catch(() => null);
  const out = await mkdtemp(path.join(tmpdir(), 'pipeops-suite-'));
  try {
    await mkdir(SUITES_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(spec, null, 1) + '\n');
    const r = await runPython(['run', 'wfeval', 'generate', name, '--out', out]);
    if (r.code !== 0) {
      if (previous === null) await unlink(file).catch(() => {});
      else await writeFile(file, previous);
      return res.status(400).json({ error: r.stderr.trim() || r.stdout.trim() || 'the harness refused this suite' });
    }
    res.json({ name });
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

app.delete('/api/suites/:name', async (req, res) => {
  if (!SUITE_NAME.test(req.params.name)) return res.status(400).json({ error: 'bad suite name' });
  await unlink(path.join(SUITES_DIR, `${req.params.name}.json`)).catch(() => {});
  res.json({ ok: true });
});

function runPython(args) {
  return new Promise((resolve) => {
    const proc = spawn('uv', args, { cwd: EVAL_DIR, env: PY_ENV });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => (stdout += b));
    proc.stderr.on('data', (b) => (stderr += b));
    proc.on('error', (e) => resolve({ code: 1, stdout, stderr: `could not start uv: ${e.message}` }));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

app.get('/api/experiment', async (req, res) => {
  const baselineId = req.query.baseline;
  const variantId = req.query.variant && req.query.variant !== baselineId ? req.query.variant : null;
  if (!baselineId) return res.status(400).json({ error: 'missing ?baseline=<runId>' });
  try {
    const baselineArtifacts = await loadRunArtifacts(RUNS_DIR, baselineId);
    const variantArtifacts = variantId ? await loadRunArtifacts(RUNS_DIR, variantId) : null;
    const bundle = buildExperimentBundle({
      baselineId,
      baselineLabel: baselineArtifacts.run.variant?.name ?? baselineId,
      baselineArtifacts,
      variantId: variantId ?? baselineId,
      variantLabel: variantArtifacts ? variantArtifacts.run.variant?.name ?? variantId : baselineArtifacts.run.variant?.name ?? baselineId,
      variantArtifacts,
    });
    res.json(bundle);
  } catch (e) {
    res.status(404).json({ error: String(e.message ?? e) });
  }
});

// A snapshot (from `wfeval snapshot`) holds restorable engine state before each agent
// step — `wfeval stage <step>` replays one agent from it. Listing is a pure file read.
app.get('/api/snapshots', async (_req, res) => {
  try {
    const entries = (await readdir(SNAPSHOTS_DIR, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory());
    const out = [];
    for (const e of entries) {
      const dir = path.join(SNAPSHOTS_DIR, e.name);
      try {
        const meta = JSON.parse(await readFile(path.join(dir, 'snapshot.json'), 'utf8'));
        const stepEntries = (await readdir(path.join(dir, 'steps'), { withFileTypes: true })).filter((s) => s.isDirectory());
        const steps = stepEntries
          .map((s) => s.name.match(/^(\d+)-p(\d+)-(.+)$/))
          .filter((m) => m && m[3] !== 'complete')
          .map((m) => ({ step: m[0], phase: Number(m[2]), task: m[3] }));
        out.push({ id: e.name, variant: meta.variant?.name ?? null, suite: meta.data?.suite ?? null, seed: meta.data?.seed ?? null, steps });
      } catch {
        // an incomplete or malformed snapshot dir — skip it, same as listRuns does for runs
      }
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

// Stage runs with their graded result as the run recorded it (checks, requests, rejected calls,
// clipped fields): what the replay panel shows for a run it just made. The per-variant stage-run
// tables use /api/stage-runs and /api/stage-runs/regraded above.
app.get('/api/stage-results', async (_req, res) => {
  try {
    const entries = (await readdir(RUNS_DIR, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
    res.json(await listStageResults(RUNS_DIR, entries));
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

const STAGE_ORDER = ['workflow-discover', 'workflow-maintain', 'workflow-deepen', 'workflow-review']; // eval/src/wfeval/stage.py ORDER

app.get('/api/wfeval/status', (_req, res) => {
  if (!live) return res.json({ running: false });
  res.json({ running: !live.done, runId: live.runId, error: live.error });
});

// Streams plain-text lines as they're produced (not quite SSE — just chunked text —
// good enough for a terminal-style live log and easy to read with a fetch stream reader).
app.post('/api/wfeval/run', async (req, res) => {
  if (live && !live.done) {
    return res.status(409).json({ error: 'a run is already in progress' });
  }
  const { variant, suite, seed, phases, repeat } = req.body ?? {};
  if (!variant || !suite || !seed) {
    return res.status(400).json({ error: 'variant, suite and seed are required' });
  }
  const args = ['run', 'wfeval', 'run', '--variant', String(variant), '--suite', String(suite), '--seed', String(seed)];
  if (phases) args.push('--phases', String(phases));
  if (repeat) args.push('--repeat', String(repeat));

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked' });
  const proc = spawn('uv', args, { cwd: EVAL_DIR, env: PY_ENV });
  live = { proc, done: false, runId: null, error: null };

  const beforeDirs = new Set(await readdir(RUNS_DIR).catch(() => []));

  const onData = (buf) => {
    const text = buf.toString('utf8');
    res.write(text);
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', async (code) => {
    live.done = true;
    if (code !== 0) {
      live.error = `wfeval run exited with code ${code}`;
      res.write(`\n[pipeops] ${live.error}\n`);
      res.end();
      return;
    }
    const afterDirs = new Set(await readdir(RUNS_DIR).catch(() => []));
    const newDir = [...afterDirs].find((d) => !beforeDirs.has(d));
    live.runId = newDir ?? null;
    if (newDir) {
      res.write(`\n[pipeops] run complete: ${newDir}\n`);
      await new Promise((resolve) => {
        const grade = spawn('uv', ['run', 'wfeval', 'grade', `runs/${newDir}`], { cwd: EVAL_DIR, env: PY_ENV });
        grade.stdout.on('data', onData);
        grade.stderr.on('data', onData);
        grade.on('close', resolve);
      });
    } else {
      res.write('\n[pipeops] run finished but no new run directory was found\n');
    }
    res.end();
  });

  proc.on('error', (err) => {
    live.done = true;
    live.error = String(err.message ?? err);
    res.write(`\n[pipeops] failed to start: ${live.error}\n`);
    res.end();
  });

  req.on('close', () => {
    // Client disconnected — let the harness keep running (it's a real model run with
    // real cost); status/log replay isn't implemented, so just leave `live` in place.
  });
});

// Replays one agent from a saved snapshot step — a real model-calling run, just a much
// shorter one than a full cycle. Same single-slot lock and streaming as /api/wfeval/run.
app.post('/api/wfeval/stage', async (req, res) => {
  if (live && !live.done) {
    return res.status(409).json({ error: 'a run is already in progress' });
  }
  const { step, task, variant, repeat, through } = req.body ?? {};
  if (!step || !variant) {
    return res.status(400).json({ error: 'step and variant are required' });
  }
  // Validate before anything is spawned: stay inside snapshots/ and variants/, and fail
  // with a readable message instead of a Python traceback.
  if (String(step).includes('..') || !/^snapshots\/[\w.-]+\/steps\/[\w.-]+$/.test(String(step)) || !(await exists(path.join(EVAL_DIR, String(step), 'step.json')))) {
    return res.status(400).json({ error: `No saved snapshot step "${step}". Snapshots live in eval/snapshots/ and are created with \`wfeval snapshot\`.` });
  }
  if (String(variant).includes('..') || !/^variants\/[\w.-]+\.json$/.test(String(variant)) || !(await exists(path.join(EVAL_DIR, String(variant))))) {
    return res.status(400).json({ error: `Unknown variant "${variant}".` });
  }
  if (task && !['workflow-discover', 'workflow-maintain', 'workflow-deepen', 'workflow-review'].includes(String(task))) {
    return res.status(400).json({ error: `Unknown task "${task}".` });
  }
  if (repeat !== undefined && !(Number.isInteger(Number(repeat)) && Number(repeat) >= 1 && Number(repeat) <= 3)) {
    return res.status(400).json({ error: 'repeat must be 1–3' });
  }
  if (through !== undefined && through !== null) {
    const first = String(task ?? String(step).match(/-p\d+-(workflow-[a-z]+)$/)?.[1] ?? '');
    if (!STAGE_ORDER.includes(String(through)) || STAGE_ORDER.indexOf(String(through)) <= STAGE_ORDER.indexOf(first)) {
      return res.status(400).json({ error: `through must be an agent after ${first || 'the step\'s agent'}: ${STAGE_ORDER.join(', ')}` });
    }
  }
  const vdef = JSON.parse(await readFile(path.join(EVAL_DIR, String(variant)), 'utf8'));
  if (!(await exists(path.join(EVAL_DIR, vdef.binary ?? '')))) {
    return res.status(409).json({ error: `The engine for variant "${vdef.name}" isn't built on this machine. Build it first: cd eval && ./setup-engine.sh ${vdef.name}` });
  }
  const args = ['run', 'wfeval', 'stage', String(step), '--variant', String(variant)];
  if (task) args.push('--task', String(task));
  if (repeat) args.push('--repeat', String(repeat));
  if (through) args.push('--through', String(through));

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked' });
  const beforeDirs = new Set(await readdir(RUNS_DIR).catch(() => []));
  const proc = spawn('uv', args, { cwd: EVAL_DIR, env: PY_ENV });
  live = { proc, done: false, runId: null, error: null };

  const onData = (buf) => res.write(buf.toString('utf8'));
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', async (code) => {
    live.done = true;
    if (code !== 0) {
      live.error = `wfeval stage exited with code ${code}`;
      res.write(`\n[pipeops] ${live.error}\n`);
    } else {
      // The UI reads this line to show the graded result from /api/stage-results.
      const newDir = [...new Set(await readdir(RUNS_DIR).catch(() => []))].find((d) => !beforeDirs.has(d));
      live.runId = newDir ?? null;
      if (newDir) res.write(`\n[pipeops] stage complete: ${newDir}\n`);
    }
    res.end();
  });

  proc.on('error', (err) => {
    live.done = true;
    live.error = String(err.message ?? err);
    res.write(`\n[pipeops] failed to start: ${live.error}\n`);
    res.end();
  });
});

const exists = (p) => access(p).then(() => true, () => false);

// Loopback only: this server can start paid model runs, so it must not be reachable from the LAN.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`pipeops server on http://localhost:${PORT} (eval dir: ${EVAL_DIR}, demo dir: ${DEMO_DIR})`);
});
