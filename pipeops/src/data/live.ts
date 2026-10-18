import type { RawExperimentBundle } from './schema';

export interface RunSummary {
  id: string;
  variant: string | null;
  suite: string | null;
  seed: number | null;
  phases: number[];
  /** Opaque key: two runs may only be compared when their keys are equal. */
  conditions: string;
  startedAt: string | null;
  finishedAt: string | null;
  qualityPassed: number;
  qualityTotal: number;
  modelRequests: number;
  runtimeSeconds: number;
}

export interface VariantSummary {
  file: string;
  name: string;
  description: string | null;
  /** false when the variant's engine binary isn't built on this machine */
  engineReady: boolean;
  setup: string | null;
}

export interface SnapshotStep {
  step: string;
  phase: number;
  task: string;
}

export interface SnapshotSummary {
  id: string;
  variant: string | null;
  suite: string | null;
  seed: number | null;
  steps: SnapshotStep[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchRuns(): Promise<RunSummary[]> {
  return json(await fetch('/api/runs'));
}

/** Bundled, sanitized runs from pipeops/demo-data/ — work without eval/runs/. */
export async function fetchDemoRuns(): Promise<RunSummary[]> {
  return json(await fetch('/api/demo-runs'));
}

export async function fetchVariants(): Promise<VariantSummary[]> {
  return json(await fetch('/api/variants'));
}

export interface SuiteSummary {
  name: string;
  builtin: boolean;
  description: string;
  jobs?: number;
  checks?: number;
  broken?: boolean;
}

export async function fetchSuites(): Promise<SuiteSummary[]> {
  return json(await fetch('/api/suites'));
}

export async function fetchSuiteSpec(name: string): Promise<unknown> {
  return json(await fetch(`/api/suites/${name}`));
}

export async function saveSuite(name: string, spec: unknown): Promise<void> {
  await json(await fetch(`/api/suites/${name}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec }) }));
}

export async function deleteSuite(name: string): Promise<void> {
  await json(await fetch(`/api/suites/${name}`, { method: 'DELETE' }));
}

export async function fetchLiveExperiment(baseline: string, variant?: string, source: 'local' | 'demo' = 'local'): Promise<RawExperimentBundle> {
  const params = new URLSearchParams({ baseline });
  if (variant) params.set('variant', variant);
  return json(await fetch(`${source === 'demo' ? '/api/demo-experiment' : '/api/experiment'}?${params}`));
}

export async function fetchStatus(): Promise<{ running: boolean; runId: string | null; error: string | null }> {
  return json(await fetch('/api/wfeval/status'));
}

/** One recorded `wfeval stage` run. Every number is null when the run did not record it. */
export interface StageRun {
  id: string;
  variant: string | null;
  suite: string | null;
  seed: number | null;
  /** 'workflow-review', or 'workflow-deepen+workflow-review' for Deepen then Review. */
  stage: string;
  snapshot: string | null;
  step: string | null;
  requests: number | null;
  seconds: number | null;
  checksPassed: number | null;
  checksScored: number | null;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  failedCalls: number | null;
  tokenSource: string | null;
  /** false when the harness failed the run (no request logged): excluded from the table, counted. */
  usable: boolean;
}

export async function fetchStageRuns(): Promise<StageRun[]> {
  return json(await fetch('/api/stage-runs'));
}

/** Checks of each stage run graded again against the suite's current truth; null where it could not be. */
export type StageRegrades = Record<string, { passed: number; scored: number; truth: string } | null>;

export async function fetchStageRegrades(): Promise<StageRegrades> {
  return json(await fetch('/api/stage-runs/regraded'));
}

export async function fetchSnapshots(): Promise<SnapshotSummary[]> {
  return json(await fetch('/api/snapshots'));
}

/** One `wfeval stage` run (server/convert.mjs stageRunSummary). Every field is null when the
 *  run did not record it. Never a full-evaluation score. */
export interface StageRunSummary {
  id: string;
  variant: string | null;
  /** The agents it ran, in order: one, or several with --through. */
  tasks: string[];
  snapshot: string | null;
  phase: number | null;
  /** What was graded: the drafts (Discover, Deepen, Maintain) or the published catalog (Review). */
  view: 'drafts' | 'catalog' | null;
  status: string | null;
  passed: number | null;
  scored: number | null;
  /** Score of the same view in the snapshot, before the agent ran (0..1). */
  scoreBefore: number | null;
  requests: number | null;
  seconds: number | null;
  output: number | null;
  /** Workflows calls the engine refused (usage.workspace.failed). */
  failedCalls: number | null;
  /** Requests per agent, for a --through chain. */
  byTask: Record<string, number | null> | null;
  /** Text Review published that the catalog saved shorter (catalog view only). */
  clipped: { fields: number; chars: number | null } | null;
  inStages: number | null;
  keywordChecks: number | null;
  truth: string | null;
  startedAt: string | null;
}

export async function fetchStageResults(): Promise<StageRunSummary[]> {
  return json(await fetch('/api/stage-results'));
}

/** Starts a live wfeval run and streams its stdout/stderr text as it arrives. Resolves when the stream ends. */
export async function streamWfevalRun(
  params: { variant: string; suite: string; seed: number; phases?: number; repeat?: number },
  onChunk: (text: string) => void,
): Promise<void> {
  const res = await fetch('/api/wfeval/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
}

/** Replays one agent from a saved snapshot step. Same streaming contract as streamWfevalRun. */
export async function streamWfevalStage(
  params: { step: string; task?: string; variant: string; repeat?: number; through?: string },
  onChunk: (text: string) => void,
): Promise<void> {
  const res = await fetch('/api/wfeval/stage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
}
