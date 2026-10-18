/**
 * PipeOps data contract.
 *
 * Convention: `null` means "not present in the evaluation artifacts yet".
 * The UI never fills a null with made-up content; it renders a labeled placeholder
 * that names the JSON path the real value will come from.
 */

export type StageId = string;

export interface StageDef {
  id: StageId;
  name: string;
  /** Short role description shown on the canvas. */
  summary: string | null;
  /** "draft" = UI copy written for the prototype, not taken from the engine. */
  summaryStatus: 'draft' | 'source';
}

export interface EvidenceLens {
  id: string;
  label: string;
}

export interface StageRecord {
  modelRequests: number | null;
  runtimeSeconds: number | null;
  snapshotId: string | null;
  output: string | null;
}

export interface WorkflowRecord {
  id: string;
  title: string;
  steps?: string[] | null;
  /** id of the ground-truth workflow it was matched to, if any */
  matchedTo?: string | null;
  /** Below: only ever present for generated workflows, read straight from catalog.json.
   *  Ground-truth entries (from truth.json) don't carry these — left undefined, not null,
   *  since truth.json simply has no such field to be "missing" from. */
  trigger?: string | null;
  outcome?: string | null;
  variations?: string[] | null;
  limitations?: string[] | null;
  /** The engine's own 1–4 confidence rating for this candidate workflow. */
  confidence?: number | null;
}

export interface CheckRecord {
  id: string;
  name: string | null;
  lens: string | null;
  passed: boolean;
  expected: string | null;
  actual: string | null;
  reason: string | null;
  evidence: string[] | null;
  /** Keyword checks only: true when the words are in the stages (what to do), false when
   *  they appear only in a variation, question or limitation. null/absent otherwise. */
  inStages?: boolean | null;
}

export interface RunMetrics {
  qualityPassed: number;
  qualityTotal: number;
  modelRequests: number;
  runtimeSeconds: number;
  /** Workflows calls the engine refused (usage.workspace.failed, summed over phases).
   *  null when the run predates that logging (started before 2026-10-17 20:00Z). */
  failedCalls?: number | null;
}

/**
 * Model usage of a whole run, summed over its phases. Every field is `null` when the
 * artifact does not record it — never 0, which would claim "measured, and none".
 * Token semantics follow the harness (eval/src/wfeval/usage.py): `input` is the uncached
 * input only; cache reads and writes are reported separately and are NOT part of `input`.
 */
export interface Efficiency {
  requests: number | null;
  runtimeSeconds: number | null;
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
  /** Where the token counts were read from. `pipe_logs` is known to undercount long runs. */
  source: 'request_log' | 'pipe_logs' | 'mixed' | null;
}

/** One graded phase of a full run. null = the artifact did not record it (not zero). */
export interface PhaseResult {
  phase: number;
  /** 'complete', or 'idle' when the engine declined to start a cycle (nothing new was recorded). */
  cycleStatus: string | null;
  /** Frames of history the phase was given (0 = nothing new was recorded). */
  frames: number | null;
  checksPassed: number | null;
  checksScored: number | null;
  requests: number | null;
  runtimeSeconds: number | null;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  /** Graded mistakes by tag, e.g. { idle_churn: 1 }. */
  mistakes: Record<string, number> | null;
}

export interface RawRun {
  id: string;
  label: string;
  role: 'baseline' | 'variant';
  status: 'recorded';
  recordedAt: string | null;
  metrics: RunMetrics;
  /** Absent on the mock placeholder and on artifacts that carry no usage at all. */
  efficiency?: Efficiency | null;
  /** Per-phase results; absent in files exported before phases were recorded. */
  phases?: PhaseResult[] | null;
  stages: Record<StageId, StageRecord>;
  recordedActivity: { description: string; sources?: string[] } | null;
  generatedWorkflows: WorkflowRecord[] | null;
  groundTruth: WorkflowRecord[] | null;
  checks: CheckRecord[] | null;
}

/** An independent review of the pair (an LLM judge), separate from the automatic checks. */
export interface PairReview {
  kind: 'llm-judge';
  judgments: number;
  pairs: { pair: string; phase: number; job: string; verdict: 'baseline' | 'variant' | 'inconsistent'; strengths: (string | null)[] }[];
  summary: { baseline: number; variant: number; inconsistent: number };
  method: { describedIn: string; note: string };
  source: { generatedBy: string; sha256: Record<string, string> };
}

export interface RawExperimentBundle {
  schemaVersion: number;
  source: { kind: 'mock' | 'artifact'; file: string; note: string };
  experiment: { id: string; title: string; subject: string; question: string };
  stages: StageDef[];
  evidenceLenses: EvidenceLens[];
  runs: RawRun[];
  comparison: {
    baseline: string;
    variant: string;
    pairing: 'single' | 'multiple';
    verdict: string;
    note: string;
    /** Present only when a review file for exactly this pair was imported. */
    review?: PairReview | null;
  };
}

/* ---------- normalized shapes used by the UI ---------- */

export interface CheckSlot extends CheckRecord {
  index: number;
  /** true when the slot was synthesized from run totals because per-check records are missing */
  derived: boolean;
}

export interface Run extends Omit<RawRun, 'checks'> {
  checks: CheckSlot[];
  checksLoaded: boolean;
}

export interface Experiment extends Omit<RawExperimentBundle, 'runs'> {
  runs: Run[];
}
