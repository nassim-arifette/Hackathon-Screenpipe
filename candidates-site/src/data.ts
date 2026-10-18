import timelinesRaw from './data/timelines.json'

export type CandidateId = 'baseline' | 'conflict' | 'preflight'

export type TimelineEvent =
  | { t: number; k: 'req' }
  | { t: number; k: 'usage'; out: number; cache: number; in: number; stop?: string }
  | { t: number; k: 'ws'; action: string; ok: boolean; msg?: string }

export const timelines = {
  baseline: (timelinesRaw as Record<string, TimelineEvent[]>)['baseline'],
  conflict: (timelinesRaw as Record<string, TimelineEvent[]>)['conflict-revision'],
  preflight: (timelinesRaw as Record<string, TimelineEvent[]>)['preflight-conflict'],
} satisfies Record<CandidateId, TimelineEvent[]>

export const candidates: Record<
  CandidateId,
  { name: string; label: string; owner: string; color: string; summary: string }
> = {
  baseline: {
    name: 'clearer-rejection',
    label: 'Baseline',
    owner: 'reference engine',
    color: '#8D929E',
    summary:
      'The reference engine. Rejections explain which items failed and why, but Review only learns that after a publish is refused.',
  },
  conflict: {
    name: 'conflict-revision',
    label: 'Conflict',
    owner: 'candidate',
    color: '#FFC24D',
    summary:
      'A 409 revision conflict now carries the current revision and the open drafts, so Review retries without another context read.',
  },
  preflight: {
    name: 'preflight-conflict',
    label: 'Preflight + Conflict',
    owner: 'our candidate',
    color: '#C8FF4D',
    summary:
      'Every draft read already contains the publish verdict, computed by a dry run of the real validation. Review fixes before it sends. 409s carry the revision too.',
  },
}

/** Sonnet (claude-sonnet-5), Review stage 04 of snapshot receipts-s1, 1 run each. */
export const sonnetReview: Record<
  CandidateId,
  { requests: number; seconds: number; rejected: number; input: number; cacheRead: number; output: number; tools: number; checks: string }
> = {
  baseline: { requests: 18, seconds: 161.5, rejected: 5, input: 54307, cacheRead: 625723, output: 17004, tools: 22, checks: '11/11' },
  conflict: { requests: 14, seconds: 106.2, rejected: 4, input: 43104, cacheRead: 401173, output: 10369, tools: 18, checks: '11/11' },
  preflight: { requests: 14, seconds: 96.1, rejected: 0, input: 32889, cacheRead: 340104, output: 8683, tools: 16, checks: '11/11' },
}

export const sonnetRejections: Record<CandidateId, { kind: string; n: number }[]> = {
  baseline: [
    { kind: '409 Workspace changed', n: 2 },
    { kind: '422 Stage retained N of M items', n: 2 },
    { kind: 'Output token limit (call not executed)', n: 1 },
  ],
  conflict: [
    { kind: '409 Workspace changed (+ revision)', n: 2 },
    { kind: '422 Stage retained N of M items', n: 2 },
  ],
  preflight: [],
}

/** GPT (gpt-6.1-sol), Review stage, 4 runs per candidate. */
export const gptReviewRuns = {
  baseline: [
    { requests: 20, seconds: 221.4, rejected: 0, input: 72690, cacheRead: 968448, output: 11324, checks: 11 },
    { requests: 21, seconds: 221.5, rejected: 1, input: 80656, cacheRead: 991104, output: 11787, checks: 11 },
    { requests: 22, seconds: 246.2, rejected: 1, input: 91704, cacheRead: 1193088, output: 10758, checks: 11 },
    { requests: 32, seconds: 361.6, rejected: 1, input: 133730, cacheRead: 1315456, output: 13156, checks: 11 },
  ],
  preflight: [
    { requests: 18, seconds: 176.1, rejected: 0, input: 70716, cacheRead: 659584, output: 8800, checks: 11 },
    { requests: 17, seconds: 185.4, rejected: 0, input: 80020, cacheRead: 750080, output: 10444, checks: 11 },
    { requests: 19, seconds: 231.0, rejected: 0, input: 68449, cacheRead: 771712, output: 9721, checks: 11 },
    { requests: 19, seconds: 196.0, rejected: 0, input: 69821, cacheRead: 795520, output: 9851, checks: 11 },
  ],
}

/** GPT full run, receipts suite, 3 phases, 1 run each. */
export const gptFullRun = {
  baseline: {
    requests: 298, seconds: 1336.4, rejected: 15, input: 801579, cacheRead: 11723264, output: 91361, agents: 55, checks: '14/14',
    phases: [ { requests: 89, seconds: 450 }, { requests: 109, seconds: 436 }, { requests: 100, seconds: 450 } ],
  },
  preflight: {
    requests: 208, seconds: 990.9, rejected: 7, input: 640409, cacheRead: 7044864, output: 63288, agents: 44, checks: '14/14',
    phases: [ { requests: 83, seconds: 480 }, { requests: 72, seconds: 330 }, { requests: 53, seconds: 180 } ],
  },
}

/** Sonnet, every stage of the receipts snapshot, 1 run each. Baseline vs preflight-conflict. */
export const sonnetStages = [
  { stage: '01 Discover', b: { checks: '2/9', requests: 18, seconds: 96, rejected: 0, input: 48400, cacheRead: 624000, output: 7400 }, p: { checks: '2/9', requests: 17, seconds: 95, rejected: 1, input: 50700, cacheRead: 573000, output: 7700 } },
  { stage: '02 Maintain', b: { checks: '8/11', requests: 5, seconds: 20, rejected: 0, input: 16800, cacheRead: 58000, output: 1200 }, p: { checks: '8/11', requests: 5, seconds: 26, rejected: 0, input: 12600, cacheRead: 62000, output: 1800 } },
  { stage: '03 Deepen', b: { checks: '11/11', requests: 14, seconds: 141, rejected: 2, input: 58300, cacheRead: 488000, output: 14800 }, p: { checks: '10/11', requests: 12, seconds: 126, rejected: 4, input: 43300, cacheRead: 322000, output: 14200 }, note: 'preflight-conflict misses type_lookup; 2 of its 4 refusals are outputs clipped at 4,096 tokens. Deepen is not touched by the patch — likely variance, 1 run.' },
  { stage: '04 Review', b: { checks: '11/11', requests: 18, seconds: 162, rejected: 5, input: 54300, cacheRead: 626000, output: 17000 }, p: { checks: '11/11', requests: 14, seconds: 96, rejected: 0, input: 32900, cacheRead: 340000, output: 8700 } },
]

export const messages = {
  baseline409: 'Workflow operation failed: 409: Workspace changed. Read context before publishing.',
  conflict409:
    'Workflow operation failed: 409: Workspace changed. Read context before publishing. Current revision: 9; catalogRevision: 0; your open drafts: [{"id":"592b5400…","version":6,"publicationRetry":{"retryable":true}}, …]',
  reject422:
    'Workflow operation failed: 422: Stage 1 retained 0 of 3 proposed procedure items. procedure[0]: quote is not in the text of the Finder capture at 2026-10-16T11:28:35Z. procedure[1]: cites TextEdit at 2026-10-16T11:29:51Z, which is not one of this stage\'s verified evidence entries…',
  preflightFail:
    '"publicationCheck": { "ok": false, "problems": "Stage 1 retained 0 of 3 proposed procedure items. procedure[0]: quote is not in the text of the Finder capture at 2026-10-16T11:28:35Z. …" }',
  preflightOk: '"publicationCheck": { "ok": true }',
}

export const fmtK = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} k` : `${n}`
export const pct = (a: number, b: number) => {
  const n = Math.round(((b - a) / a) * 100)
  return `${n < 0 ? '−' : n > 0 ? '+' : ''}${Math.abs(n)}%`
}
