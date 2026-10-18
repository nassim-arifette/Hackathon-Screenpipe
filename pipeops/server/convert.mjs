// Converts real wfeval run artifacts (eval/runs/<id>/{run.json,results.jsonl,truth.json,
// phase*/catalog.json}) into the RawExperimentBundle shape the frontend understands
// (src/data/schema.ts). Honest-null convention preserved: a field stays null unless the
// artifacts actually say it — nothing here is invented.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { conditionsKey, fullRunProblem } from './portable.mjs';

const STAGES = [
  { id: 'discover', name: 'Discover', summary: 'Finds candidate workflows.' },
  { id: 'maintain', name: 'Maintain', summary: 'Merges and updates workflows.' },
  { id: 'deepen', name: 'Deepen', summary: 'Adds steps and exceptions.' },
  { id: 'review', name: 'Review', summary: 'Checks before publishing.' },
];

const EVIDENCE_LENSES = [
  { id: 'workflow-discovery', label: 'Workflow discovery' },
  { id: 'exception-handling', label: 'Exception handling' },
  { id: 'noise-filtering', label: 'Noise filtering' },
  { id: 'evidence-validity', label: 'Evidence validity' },
];

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readJsonl(file) {
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function readPhaseCatalogs(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const catalogs = {};
  for (const e of entries) {
    const m = e.isDirectory() && e.name.match(/^phase(\d+)$/);
    if (!m) continue;
    catalogs[Number(m[1])] = await readJson(path.join(dir, e.name, 'catalog.json')).catch(() => null);
  }
  return catalogs;
}

/** Per-phase agent executions (start/finish/duration per pipe run) and each agent's own
 *  end-of-cycle note, from phase<N>/executions.json and phase<N>/phase.json. */
async function readPhaseMeta(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const meta = {};
  for (const e of entries) {
    const m = e.isDirectory() && e.name.match(/^phase(\d+)$/);
    if (!m) continue;
    const [executions, phase] = await Promise.all([
      readJson(path.join(dir, e.name, 'executions.json')).catch(() => null),
      readJson(path.join(dir, e.name, 'phase.json')).catch(() => null),
    ]);
    // An idle phase ran no cycle: its `cycle` is the previous phase's, notes included. Reading
    // them again would credit that phase's agents twice.
    meta[Number(m[1])] = { executions, notes: phase?.cycle_status === 'idle' ? null : phase?.cycle?.notes ?? null };
  }
  return meta;
}

/** Reads every artifact for one run directory and returns the raw pieces, or throws. */
export async function loadRunArtifacts(runsDir, runId) {
  const dir = path.join(runsDir, runId);
  const [run, results, truth, catalogs, phaseMeta] = await Promise.all([
    readJson(path.join(dir, 'run.json')),
    readJsonl(path.join(dir, 'results.jsonl')),
    readJson(path.join(dir, 'truth.json')).catch(() => null),
    readPhaseCatalogs(dir),
    readPhaseMeta(dir),
  ]);
  return { dir, run, results, truth, catalogs, phaseMeta };
}

export async function listRuns(runsDir, entries) {
  const out = [];
  for (const id of entries) {
    try {
      const { run, results } = await loadRunArtifacts(runsDir, id);
      // Stage / snapshot runs grade a single agent, not a full cycle — never list them as
      // full evaluation scores (they aren't comparable to them).
      if (fullRunProblem(run, results)) continue;
      const totalRequests = results.reduce((s, r) => s + (r.usage?.requests ?? 0), 0);
      const totalSeconds = results.reduce((s, r) => s + (r.seconds ?? 0), 0);
      const passed = results.reduce((s, r) => s + (r.passed ?? 0), 0);
      const scored = results.reduce((s, r) => s + (r.scored ?? 0), 0);
      out.push({
        id,
        variant: run.variant?.name ?? null,
        suite: run.data?.suite ?? null,
        seed: run.data?.seed ?? null,
        phases: results.map((r) => r.phase),
        conditions: conditionsKey({ suite: run.data?.suite, seed: run.data?.seed, repeat: results[0]?.repeat,
          phases: results.map((r) => r.phase), dataSha256: run.data?.sha256 }),
        startedAt: run.started_at ?? null,
        finishedAt: run.finished_at ?? null,
        qualityPassed: passed,
        qualityTotal: scored,
        modelRequests: totalRequests,
        runtimeSeconds: Math.round(totalSeconds),
      });
    } catch {
      // Not a complete run directory (still running, or missing artifacts) — skip it.
    }
  }
  out.sort((a, b) => (a.id < b.id ? 1 : -1));
  return out;
}

/* ---------- per-check enrichment from truth.json + catalog.json ---------- */

/** Which evidence lens a check kind belongs to — a direct reading of truth.json's own
 *  taxonomy (grade.py tags non-"steps" keyword checks as "exception_missed", absent_app
 *  checks are literally noise filtering, "evidence" checks are evidence validity). Not a
 *  guess: every other kind is about whether/which workflow got discovered. */
function lensForCheck(t) {
  if (!t) return null;
  if (t.kind === 'keywords') return t.id === 'steps' ? 'workflow-discovery' : 'exception-handling';
  if (t.kind === 'absent_app') return 'noise-filtering';
  if (t.kind === 'evidence') return 'evidence-validity';
  if (t.kind === 'cost') return null;
  return 'workflow-discovery';
}

function titleCaseKind(kind) {
  return { published: 'Published', single: 'No duplicate', keywords: 'Keyword', absent_app: 'Noise excluded',
    drift: 'Drift', separate: 'Kept separate', unpublished: 'Stays unpublished', evidence: 'Evidence',
    cost: 'Cost' }[kind] ?? kind;
}

function nameForCheck(id, t) {
  const job = t?.job ? ` — ${t.job}` : '';
  return `${titleCaseKind(t?.kind)}: ${id}${job}`;
}

function describeExpected(t) {
  if (!t) return null;
  switch (t.kind) {
    case 'published':
      return `A workflow for "${t.job}" gets published.`;
    case 'single':
      return `Exactly one workflow is published for "${t.job}" — no duplicate.`;
    case 'keywords':
      if (t.all) return `Workflow text mentions all of: ${t.all.map((g) => `[${g.join(', ')}]`).join(' and ')}.`;
      if (t.any) return `Workflow text mentions any of: ${t.any.join(', ')}.`;
      return null;
    case 'absent_app':
      return `"${t.app}" is not treated as a step.`;
    case 'drift':
      return `The existing "${t.job}" workflow adapts in place (not forked) to mention: ${(t.any ?? []).join(', ')}.`;
    case 'separate':
      return `"${t.job}" stays a separate workflow from "${t.from}" (not merged).`;
    case 'unpublished':
      return `"${t.job}" is a one-off — it should NOT be published.`;
    case 'evidence':
      return 'Every citation in every published workflow resolves to a real seeded frame.';
    case 'cost':
      return null; // informational, never scored (grade_phase leaves this check's pass null)
    default:
      return null;
  }
}

/** Reverse-looks-up the generated workflow title attributed to a job, for this phase. */
function titleForJob(phaseResult, job) {
  for (const [title, j] of Object.entries(phaseResult.workflows_by_job ?? {})) if (j === job) return title;
  return null;
}

function findWorkflow(catalog, title) {
  return (catalog?.analysis?.workflows ?? []).find((w) => w.title === title) ?? null;
}

function describeActual(phaseResult, catalog, t) {
  if (!t) return null;
  if (t.kind === 'cost') return null;
  if (t.kind === 'evidence') {
    const n = catalog?.analysis?.workflows?.length ?? null;
    return n === null ? null : `${n} workflow(s) in the published catalog this phase.`;
  }
  if (!t.job) return null;
  const title = titleForJob(phaseResult, t.job);
  if (!title) return t.kind === 'unpublished' ? `No workflow published for "${t.job}" (correct).` : `No workflow published for "${t.job}".`;
  const w = findWorkflow(catalog, title);
  if (!w?.description) return title;
  return w.description.length > 300 ? `${w.description.slice(0, 300)}…` : w.description;
}

// Screen-chrome lines (window furniture, not content) that aren't worth quoting as evidence.
const CHROME_LINES = new Set(['sidebar', 'edited', 'share', 'zoom in', 'zoom out', 'markup', 'highlight', 'rotate', 'search']);

function summarizeDetail(detail) {
  const lines = (detail ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !CHROME_LINES.has(l.toLowerCase()));
  const text = lines.slice(0, 2).join(' · ');
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function evidenceForCheck(phaseResult, catalog, t) {
  const out = [];
  if (t?.on_screen?.length) out.push(...t.on_screen.map((s) => `seeded on screen: "${s}"`));
  if (t?.job) {
    const title = titleForJob(phaseResult, t.job);
    const w = findWorkflow(catalog, title);
    for (const e of (w?.evidence ?? []).slice(0, 3)) {
      const summary = summarizeDetail(e.detail);
      if (summary) out.push(`${e.app} @ ${e.timestamp}: "${summary}"`);
    }
  }
  return out.length ? out : null;
}

function buildChecks(results, truth, catalogs) {
  const byId = new Map();
  for (const t of truth?.checks ?? []) byId.set(t.id, t);
  const out = [];
  let index = 0;
  for (const phaseResult of results) {
    const catalog = catalogs[phaseResult.phase] ?? null;
    for (const [id, c] of Object.entries(phaseResult.checks ?? {})) {
      if (c.pass === null) continue; // not scored this phase (e.g. the cost check, a no-op kind)
      const t = byId.get(id);
      out.push({
        id: `${id}-p${phaseResult.phase}`,
        index: index++,
        name: nameForCheck(id, t),
        lens: lensForCheck(t),
        passed: c.pass,
        expected: describeExpected(t),
        actual: describeActual(phaseResult, catalog, t),
        reason: c.reason ?? null,
        // Keyword checks only: true when the words are in the stages (what to do), false when
        // they appear only in a variation, question or limitation. Reported, never scored.
        inStages: typeof c.in_stages === 'boolean' ? c.in_stages : null,
        evidence: evidenceForCheck(phaseResult, catalog, t),
      });
    }
  }
  return out;
}

const NOTE_MAX = 1500;
const OUTPUT_MAX = 3900; // the portable format refuses any string over 4000 characters

/** One agent's notes, one per phase, each cut to NOTE_MAX. Only when the joined text would pass the
 *  format's string limit (long notes in every phase) are they cut further, evenly: a note is never
 *  dropped, and a run whose notes already fit is exported exactly as before. */
function joinNotes(items, multi) {
  if (!items?.length) return null;
  const build = (max) =>
    items
      .map(({ phase, text }) => {
        const clip = text.length > max ? `${text.slice(0, max)}…` : text;
        return multi ? `Phase ${phase}: ${clip}` : clip;
      })
      .join('\n\n');
  const full = build(NOTE_MAX);
  if (full.length <= OUTPUT_MAX) return full;
  const overhead = items.length * 12 + (items.length - 1) * 2;
  return build(Math.floor((OUTPUT_MAX - overhead) / items.length) - 1);
}

function buildStages(results, phaseMeta = {}) {
  const byTask = {};
  const seconds = {}; // sum of the agent's execution durations (ms) across its runs
  const notes = {};
  for (const [phase, meta] of Object.entries(phaseMeta)) {
    for (const [pipe, runs] of Object.entries(meta.executions ?? {})) {
      const id = pipe.replace(/^workflow-/, '');
      const ms = runs.reduce((s, r) => s + (typeof r.duration_ms === 'number' ? r.duration_ms : 0), 0);
      if (runs.length) seconds[id] = (seconds[id] ?? 0) + ms / 1000;
    }
    for (const [pipe, text] of Object.entries(meta.notes ?? {})) {
      if (typeof text !== 'string' || !text.trim()) continue;
      const id = pipe.replace(/^workflow-/, '');
      (notes[id] ??= []).push({ phase, text: text.trim() });
    }
  }
  for (const r of results) {
    for (const [task, u] of Object.entries(r.usage?.by_task ?? {})) {
      const id = task.replace(/^workflow-/, '');
      byTask[id] = (byTask[id] ?? 0) + (u.requests ?? 0);
    }
  }
  const stages = {};
  for (const s of STAGES) {
    stages[s.id] = {
      modelRequests: byTask[s.id] ?? null,
      // Summed agent execution time from executions.json (agents can overlap, so these do not
      // add up to the run's wall-clock runtime). Absent -> null, never estimated.
      runtimeSeconds: seconds[s.id] != null ? Math.round(seconds[s.id]) : null,
      snapshotId: null, // full evaluations don't save snapshots (wfeval snapshot does)
      // The agent's own end-of-cycle note (phase.json cycle.notes), verbatim.
      output: joinNotes(notes[s.id], Object.keys(phaseMeta).length > 1),
    };
  }
  return stages;
}

/** Picks the latest phase's catalog — the most recently reviewed version of each workflow. */
function latestCatalog(catalogs) {
  const phases = Object.keys(catalogs).map(Number).sort((a, b) => b - a);
  for (const p of phases) if (catalogs[p]) return catalogs[p];
  return null;
}

function buildWorkflows(results, catalogs) {
  const byJob = new Map();
  for (const r of results) {
    for (const [title, job] of Object.entries(r.workflows_by_job ?? {})) {
      byJob.set(title, job);
    }
  }
  if (byJob.size === 0) return null;
  const catalog = latestCatalog(catalogs);
  let i = 0;
  return [...byJob.entries()].map(([title, job]) => {
    const w = findWorkflow(catalog, title);
    return {
      id: `wf-${i++}`,
      title,
      steps: w?.stages?.length ? w.stages.map((s) => s.name) : null,
      matchedTo: job,
      trigger: w?.trigger ?? null,
      outcome: w?.outcome ?? null,
      variations: w?.variations?.length ? w.variations : null,
      limitations: w?.limitations?.length ? w.limitations : null,
      confidence: typeof w?.confidence === 'number' ? w.confidence : null,
    };
  });
}

function buildGroundTruth(truth) {
  if (!truth?.jobs) return null;
  return Object.entries(truth.jobs).map(([id, j]) => ({ id, title: j.summary ?? id }));
}

/** Workflows calls the engine refused, summed across phases (usage.workspace.failed). null when
 *  no phase carries the field — the run predates the logging (started before 2026-10-17 20:00Z). */
function failedCalls(results) {
  let present = false;
  let total = 0;
  for (const r of results) {
    const n = r.usage?.workspace?.failed;
    if (typeof n === 'number') {
      present = true;
      total += n;
    }
  }
  return present ? total : null;
}

const USAGE_KEYS = ['requests', 'input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Usage summed over phases, strictly: a field is null unless every phase recorded it, so a
 *  run (or a phase) with no usage data is "missing", not zero. */
export function efficiencyOf(results) {
  if (!results.length || !results.every((r) => r.usage && typeof r.usage === 'object')) return null;
  const total = Object.fromEntries(
    USAGE_KEYS.map((k) => [k, results.every((r) => isNum(r.usage[k])) ? results.reduce((s, r) => s + r.usage[k], 0) : null]),
  );
  const sources = new Set(results.map((r) => r.usage.source ?? null));
  const source = sources.size === 1 && !sources.has(null) ? [...sources][0] : sources.has(null) ? null : 'mixed';
  const seconds = results.every((r) => isNum(r.seconds)) ? Math.round(results.reduce((s, r) => s + r.seconds, 0)) : null;
  return { ...total, runtimeSeconds: seconds, source };
}

/** One entry per graded phase, straight from results.jsonl. Anything a phase did not record
 *  is null (never 0); `frames` is the history the phase was given, from run.json. */
export function phasesOf(results, run) {
  const n = (v) => (isNum(v) ? v : null);
  return results.map((r) => ({
    phase: r.phase,
    cycleStatus: typeof r.cycle === 'string' ? r.cycle : null,
    frames: n(run.data?.frames?.[String(r.phase)]),
    checksPassed: n(r.passed),
    checksScored: n(r.scored),
    requests: n(r.usage?.requests),
    runtimeSeconds: n(r.seconds) === null ? null : Math.round(r.seconds),
    inputTokens: n(r.usage?.input),
    cacheReadTokens: n(r.usage?.cacheRead),
    cacheWriteTokens: n(r.usage?.cacheWrite),
    outputTokens: n(r.usage?.output),
    mistakes: r.mistakes && typeof r.mistakes === 'object' ? r.mistakes : null,
  }));
}

export function toRawRun(id, label, role, { run, results, truth, catalogs, phaseMeta }) {
  const passed = results.reduce((s, r) => s + (r.passed ?? 0), 0);
  const scored = results.reduce((s, r) => s + (r.scored ?? 0), 0);
  const requests = results.reduce((s, r) => s + (r.usage?.requests ?? 0), 0);
  const seconds = results.reduce((s, r) => s + (r.seconds ?? 0), 0);
  return {
    id,
    label,
    role,
    status: 'recorded',
    recordedAt: run.finished_at ?? null,
    metrics: {
      qualityPassed: passed,
      qualityTotal: scored,
      modelRequests: requests,
      runtimeSeconds: Math.round(seconds),
      failedCalls: failedCalls(results),
    },
    efficiency: efficiencyOf(results),
    phases: phasesOf(results, run),
    stages: buildStages(results, phaseMeta),
    recordedActivity: null,
    generatedWorkflows: buildWorkflows(results, catalogs),
    groundTruth: buildGroundTruth(truth),
    checks: buildChecks(results, truth, catalogs),
  };
}

function verdict(a, b) {
  if (a.id === b.id) return { verdict: 'Single run loaded.', note: 'Pick a variant run to pair it against.' };
  const dq = b.metrics.qualityPassed - a.metrics.qualityPassed;
  const dr = b.metrics.modelRequests - a.metrics.modelRequests;
  const ds = b.metrics.runtimeSeconds - a.metrics.runtimeSeconds;
  const checks = `${b.metrics.qualityPassed}/${b.metrics.qualityTotal}`;
  const rel = a.metrics.modelRequests ? Math.round((dr / a.metrics.modelRequests) * 100) : null;
  const relTxt = rel === null ? '' : ` (${rel > 0 ? '+' : '−'}${Math.abs(rel)}%)`;
  if (dq < 0) return { verdict: 'Regression: quality dropped.', note: `${a.label} ${a.metrics.qualityPassed}/${a.metrics.qualityTotal} -> ${b.label} ${checks}.` };
  if (dq > 0) return { verdict: 'More checks passed.', note: `+${dq} checks, ${dr >= 0 ? '+' : ''}${dr} requests. Checks do not measure document quality.` };
  // Passing the same checks does not show the documents are equally good: the checks only ask
  // whether the right jobs and exceptions are named.
  if (dr < 0 && ds <= 0) return { verdict: 'Efficiency improved. Document quality needs further validation.', note: `Same ${checks} checks passed; ${-dr} fewer requests${relTxt}.` };
  if (dr < 0) return { verdict: 'Fewer requests, longer runtime. Document quality needs further validation.', note: `Same ${checks} checks passed.` };
  if (dr > 0) return { verdict: 'No improvement demonstrated.', note: `Same quality, ${dr} more requests${relTxt}.` };
  return { verdict: 'No change detected.', note: 'Identical totals.' };
}

/** Recorded stage runs (`wfeval stage`): one agent, or Deepen then Review, started from a saved
 *  snapshot step. They are listed on their own because they are not full evaluations and must
 *  never be scored or compared against one. `usable` is false for a run the harness itself
 *  failed (no request logged, or tokens only from the truncated pipe logs): kept in the list so
 *  the page can say how many were left out, never silently dropped. */
export async function listStageRuns(runsDir, entries) {
  const out = [];
  for (const id of entries) {
    try {
      const [row] = await readJsonl(path.join(runsDir, id, 'results.jsonl'));
      if (!row || row.stage === undefined) continue;
      const u = row.usage ?? {};
      const n = (v) => (isNum(v) ? v : null);
      const [snapshot, step] = String(row.snapshot ?? '').split('/');
      out.push({
        id,
        variant: row.variant ?? null,
        suite: row.suite ?? null,
        seed: isNum(row.seed) ? row.seed : null,
        stage: row.stage,
        snapshot: snapshot || null,
        step: step ?? null,
        requests: n(u.requests),
        seconds: n(row.seconds) === null ? null : Math.round(row.seconds),
        checksPassed: n(row.passed),
        checksScored: n(row.scored),
        inputTokens: n(u.input),
        cacheReadTokens: n(u.cacheRead),
        cacheWriteTokens: n(u.cacheWrite),
        outputTokens: n(u.output),
        failedCalls: n(u.workspace?.failed), // null where the run predates that logging
        tokenSource: u.source ?? null,
        usable: row.status === 'done' && u.source === 'request_log' && (u.requests ?? 0) > 0,
      });
    } catch {
      // not a stage run directory, or one still running
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Assembles the UI bundle from two already-built RawRuns (local artifacts or demo files). */
export function bundleFromRuns({ baseRun, varRun, suite, source, hasVariant }) {
  const { verdict: v, note } = verdict(baseRun, varRun);
  return {
    schemaVersion: 1,
    source,
    experiment: {
      id: suite,
      title: `Workflow discovery — ${suite}`,
      subject: 'Screenpipe Workflows',
      question: hasVariant ? `Does ${varRun.label} improve on ${baseRun.label}?` : `How did ${baseRun.label} do?`,
    },
    stages: STAGES.map((s) => ({ id: s.id, name: s.name, summary: s.summary, summaryStatus: 'draft' })),
    evidenceLenses: EVIDENCE_LENSES,
    runs: [baseRun, varRun],
    comparison: {
      baseline: baseRun.id,
      variant: varRun.id,
      pairing: 'single',
      verdict: v,
      note,
    },
  };
}

export function buildExperimentBundle({ baselineId, baselineLabel, baselineArtifacts, variantId, variantLabel, variantArtifacts }) {
  const keyOf = (a) => conditionsKey({ suite: a.run.data?.suite, seed: a.run.data?.seed, repeat: a.results[0]?.repeat,
    phases: a.results.map((r) => r.phase), dataSha256: a.run.data?.sha256 });
  if (variantArtifacts && keyOf(baselineArtifacts) !== keyOf(variantArtifacts)) {
    throw new Error('these runs used different test conditions (suite, seed, phases or data) and cannot be compared');
  }
  const baseRun = toRawRun(baselineId, baselineLabel, 'baseline', baselineArtifacts);
  const varRun = variantArtifacts
    ? toRawRun(variantId, variantLabel, 'variant', variantArtifacts)
    : toRawRun(baselineId, baselineLabel, 'variant', baselineArtifacts);
  return bundleFromRuns({
    baseRun, varRun, hasVariant: Boolean(variantArtifacts),
    suite: baselineArtifacts.run.data?.suite ?? 'unknown',
    source: {
      kind: 'artifact',
      file: `eval/runs/${baselineId}/results.jsonl`,
      note: 'Live from wfeval run artifacts via the pipeops server. Per-stage runtime is the summed agent execution time from executions.json.',
    },
  });
}

/** One stage run (`wfeval stage`): one agent, or a chain with --through, from a saved
 *  snapshot step. Read straight from its results.jsonl line — never a full-evaluation score. */
export function stageResultSummary(id, run, line) {
  const usage = line.usage ?? {};
  const tasks = String(line.stage ?? run.task ?? '').split('+').filter(Boolean);
  const byTask = tasks.length > 1 && usage.by_task
    ? Object.fromEntries(Object.entries(usage.by_task).map(([t, u]) => [t, u?.requests ?? null]))
    : null;
  const scoreOf = (v) => (typeof v?.score === 'number' ? v.score : null);
  return {
    id,
    variant: line.variant ?? run.variant?.name ?? null,
    tasks,
    snapshot: line.snapshot ?? null,
    phase: typeof line.phase === 'number' ? line.phase : null,
    view: line.view ?? null,
    status: line.status ?? null,
    passed: typeof line.passed === 'number' ? line.passed : null,
    scored: typeof line.scored === 'number' ? line.scored : null,
    scoreBefore: scoreOf(line.before?.[line.view]),
    requests: typeof usage.requests === 'number' ? usage.requests : null,
    seconds: typeof line.seconds === 'number' ? Math.round(line.seconds) : null,
    output: typeof usage.output === 'number' ? usage.output : null,
    failedCalls: typeof usage.workspace?.failed === 'number' ? usage.workspace.failed : null,
    byTask,
    clipped: line.clipped && typeof line.clipped.fields === 'number' ? { fields: line.clipped.fields, chars: line.clipped.chars ?? null } : null,
    inStages: typeof line.in_stages === 'number' ? line.in_stages : null,
    keywordChecks: typeof line.keyword_checks === 'number' ? line.keyword_checks : null,
    truth: line.truth ?? null,
    startedAt: run.started_at ?? null,
  };
}

/** Every stage run in the runs dir with its graded result, newest first. A dir without stage.json is a full run
 *  (listed by listRuns); an unreadable one is skipped, as listRuns does. */
export async function listStageResults(runsDir, entries) {
  const out = [];
  for (const id of entries) {
    const dir = path.join(runsDir, id);
    try {
      await readFile(path.join(dir, 'stage.json'), 'utf8');
      const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'));
      const line = JSON.parse((await readFile(path.join(dir, 'results.jsonl'), 'utf8')).split('\n').find((l) => l.trim()));
      out.push(stageResultSummary(id, run, line));
    } catch {
      // not a stage run, or one still in progress / aborted
    }
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}
