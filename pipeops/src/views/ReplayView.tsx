import { ANIMATED, useTheme } from '../lib/theme';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Experiment, Run, StageId } from '../data/schema';
import { Badge, Eyebrow, GhostButton, Missing, PlayIcon, PrimaryButton, Select } from '../components/ui';
import { pad2 } from '../lib/format';
import { usePlayKey } from '../lib/events';
import {
  fetchSnapshots,
  fetchStageRegrades,
  fetchStageResults,
  fetchStageRuns,
  fetchVariants,
  streamWfevalStage,
  type SnapshotSummary,
  type StageRegrades,
  type StageRun,
  type StageRunSummary,
  type VariantSummary,
} from '../data/live';
import { StageRunsTable } from '../components/StageRunsTable';

/* graph geometry */
const GW = 1680;
const GH = 296;
const MAIN_Y = 80;
const BRANCH_Y = 216;
const ORIGIN_X = 40;
const END_X = 1630;
const stageX = (i: number) => 310 + i * 375;
const snapX = (i: number) => stageX(i) - 180;
const EASE = [0.22, 1, 0.36, 1] as const;

export function ReplayView({
  experiment,
  run,
  stage,
  onStage,
}: {
  experiment: Experiment;
  run: Run;
  stage: StageId | null;
  onStage: (s: StageId) => void;
}) {
  const pal = ANIMATED[useTheme()];
  const stages = experiment.stages;
  const selIdx = Math.max(0, stages.findIndex((s) => s.id === (stage ?? stages[2]?.id)));
  const sel = stages[selIdx];
  const [configId, setConfigId] = useState(run.id);
  const [sim, setSim] = useState(0); // 0 idle · 1 branch drawn · 2.. stage k lit · last = eval
  const timers = useRef<number[]>([]);
  const downstream = stages.slice(selIdx);
  const upstream = stages.slice(0, selIdx);
  const lastSim = downstream.length + 2;

  // Real execution, separate from the preview above: a saved snapshot step for this
  // stage, if one exists, lets `wfeval stage` replay the actual agent.
  const [snapshots, setSnapshots] = useState<SnapshotSummary[] | null>(null);
  const [backendDown, setBackendDown] = useState(false);
  const [variants, setVariants] = useState<VariantSummary[]>([]);
  const [realVariant, setRealVariant] = useState('');
  const [stageError, setStageError] = useState<string | null>(null);
  const [realOpen, setRealOpen] = useState(false);
  const [stageRuns, setStageRuns] = useState<StageRun[] | null>(null);
  const [regrades, setRegrades] = useState<StageRegrades | null>(null);
  const [recordedOpen, setRecordedOpen] = useState(false);
  // The graded result of the replay just run (read from the new run's own files), and --through: also run the agents after this one.
  const [stageResults, setStageResults] = useState<StageRunSummary[]>([]);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [chain, setChain] = useState(false);
  const [stageRunning, setStageRunning] = useState(false);
  const [stageLog, setStageLog] = useState('');
  const stageLogRef = useRef<HTMLDivElement>(null);

  const loadSnapshots = () => {
    setBackendDown(false);
    fetchSnapshots()
      .then(setSnapshots)
      .catch(() => {
        setBackendDown(true);
        setSnapshots([]);
      });
    fetchVariants().then(setVariants).catch(() => setVariants([]));
  };
  useEffect(loadSnapshots, []);
  useEffect(() => {
    fetchStageRuns().then(setStageRuns).catch(() => setStageRuns([]));
    fetchStageRegrades().then(setRegrades).catch(() => setRegrades(null));
  }, []);
  useEffect(() => {
    stageLogRef.current?.scrollTo({ top: stageLogRef.current.scrollHeight });
  }, [stageLog]);

  const clear = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => clear, []);
  useEffect(() => {
    clear();
    setSim(0);
    if (!stageRunning) {
      setRealOpen(false); // switching stage collapses the real-execution panel
      setLastRunId(null); // and a just-run result belongs to the stage it ran from
    }
    setRecordedOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selIdx, configId, run.id]);

  const preview = () => {
    clear();
    setSim(0);
    for (let k = 1; k <= lastSim; k++) timers.current.push(window.setTimeout(() => setSim(k), 250 + k * 520));
  };
  usePlayKey(preview);

  const config = experiment.runs.find((r) => r.id === configId)!;
  const upstreamReq = upstream.map((s) => run.stages[s.id]?.modelRequests ?? null);
  const reusedRequests = upstreamReq.every((v) => v !== null) ? upstreamReq.reduce<number>((t, v) => t + (v ?? 0), 0) : null;

  const task = `workflow-${sel.id}`;
  const lastStage = stages[stages.length - 1];
  const throughTask = downstream.length > 1 ? `workflow-${lastStage.id}` : null;
  const runChain = chain && throughTask !== null;
  const lastRun = lastRunId ? stageResults.find((r) => r.id === lastRunId) ?? null : null;
  const match = (snapshots ?? []).flatMap((snap) => snap.steps.filter((s) => s.task === task).map((s) => ({ snap, s })))[0];

  // The real replay runs the variant picked here, defaulting to the "Replay with config"
  // choice above when a variant file of that name exists, else the snapshot's own variant.
  useEffect(() => {
    const byConfig = variants.find((v) => v.name === config.label);
    const bySnapshot = variants.find((v) => v.name === match?.snap.variant);
    setRealVariant((byConfig ?? bySnapshot ?? variants[0])?.file ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variants, config.label, match?.snap.id]);
  const chosen = variants.find((v) => v.file === realVariant);

  const runStageReplay = async () => {
    if (!match || !chosen) return;
    setStageRunning(true);
    setStageError(null);
    setStageLog('');
    let log = '';
    try {
      await streamWfevalStage(
        { step: `snapshots/${match.snap.id}/steps/${match.s.step}`, task, variant: chosen.file, repeat: 1, ...(runChain ? { through: throughTask! } : {}) },
        (chunk) => {
          log += chunk;
          setStageLog((l) => l + chunk);
        },
      );
      // The server names the new run dir; read its graded result instead of leaving only a log.
      const done = log.match(/\[pipeops\] stage complete: (\S+)/)?.[1];
      if (done) {
        const fresh = await fetchStageResults().catch(() => null);
        if (fresh) setStageResults(fresh);
        setLastRunId(done);
      }
      // The harness reports failure as text on the stream; surface it as a sentence, keep the raw log below.
      if (/Traceback|\[pipeops\].*(exited with code|failed to start)/.test(log)) {
        const lines = log.split('\n').map((l) => l.trim()).filter(Boolean);
        const cause = [...lines].reverse().find((l) => /^\w*(Error|Exception)\b|exited with code|failed to start/.test(l));
        setStageError(`The stage replay did not complete${cause ? `: ${cause.replace(/^\[pipeops\]\s*/, '')}` : '.'}`);
      }
    } catch (e) {
      setStageError((e as Error).message);
    } finally {
      setStageRunning(false);
    }
  };

  // Recorded stage runs exist for Review alone and for Deepen then Review (the chain starts at Deepen's step).
  const recordedStage =
    sel.id === 'discover' ? 'workflow-discover' : sel.id === 'maintain' ? 'workflow-maintain' : sel.id === 'review' ? 'workflow-review' : sel.id === 'deepen' ? 'workflow-deepen+workflow-review' : null;
  const recordedRuns = recordedStage ? (stageRuns ?? []).filter((r) => r.stage === recordedStage) : [];
  const recordedVariants = new Set(recordedRuns.filter((r) => r.usable).map((r) => r.variant)).size;

  const forkX = snapX(selIdx);
  const branchPath = `M ${forkX} ${MAIN_Y} C ${forkX} ${BRANCH_Y - 40}, ${forkX + 40} ${BRANCH_Y}, ${forkX + 110} ${BRANCH_Y} L ${END_X} ${BRANCH_Y}`;

  return (
    <div className="relative flex h-full flex-col px-[120px] pt-8">
      {/* header */}
      <div className="flex items-end justify-between">
        <div>
          <Eyebrow size="lg">Replay preview · {sel.name}</Eyebrow>
          <h2 className="mt-3 text-[54px] font-semibold leading-none tracking-tightest text-ink-50">
            Replay a stage. Resume from a snapshot.
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <Badge size="lg" kind="simulated" label="Replay Preview" />
        </div>
      </div>

      {/* branch graph */}
      <div className="relative mt-6 shrink-0" style={{ width: GW, height: GH }}>
        <svg width={GW} height={GH} className="absolute inset-0 overflow-visible">
          <defs>
            <pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="7" height="7" fill="rgb(var(--ink-850))" />
              <line x1="0" y1="0" x2="0" y2="7" stroke="rgb(var(--signal))" strokeOpacity=".35" strokeWidth="2" />
            </pattern>
            <filter id="glow-b" filterUnits="userSpaceOnUse" x="-50" y="-50" width={GW + 100} height={GH + 100}>
              <feGaussianBlur stdDeviation="4" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* recorded main line: solid */}
          <line x1={ORIGIN_X} x2={END_X} y1={MAIN_Y} y2={MAIN_Y} stroke="rgb(var(--ink-300))" strokeWidth="2" />
          {/* portion that gets replaced on the branch */}
          <motion.line
            x1={forkX}
            x2={END_X}
            y1={MAIN_Y}
            y2={MAIN_Y}
            stroke="rgb(var(--ink-950))"
            strokeWidth="2"
            strokeDasharray="4 6"
            initial={false}
            animate={{ opacity: sim > 0 ? 1 : 0 }}
          />

          {/* simulated branch */}
          <path d={branchPath} stroke="rgb(var(--ink-700))" strokeWidth="2" fill="none" strokeDasharray="5 7" />
          <motion.path
            key={`b-${selIdx}-${configId}`}
            d={branchPath}
            stroke="rgb(var(--signal))"
            strokeWidth="2.5"
            fill="none"
            filter="url(#glow-b)"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: sim >= 1 ? 1 : 0 }}
            transition={{ duration: 0.5 + downstream.length * 0.45, ease: 'easeInOut' }}
          />
          {sim >= 1 && <path d={branchPath} stroke="rgb(var(--signal))" strokeOpacity=".5" strokeWidth="1" fill="none" className="dash-flow" />}

          {/* snapshots: diamonds between stages */}
          {stages.map((s, i) => {
            const x = snapX(i);
            const isFork = i === selIdx;
            return (
              <g key={s.id} transform={`translate(${x} ${MAIN_Y})`} className="cursor-pointer" onClick={() => onStage(s.id)}>
                <g transform="rotate(45)">
                  <motion.rect
                    initial={false}
                    animate={{
                      x: isFork ? -13 : -9,
                      y: isFork ? -13 : -9,
                      width: isFork ? 26 : 18,
                      height: isFork ? 26 : 18,
                      fill: isFork ? pal.signal : pal.bg,
                      stroke: isFork ? pal.signal : pal.line,
                    }}
                    strokeWidth={1.5}
                    strokeDasharray={run.stages[s.id]?.snapshotId || isFork ? undefined : '3 2'}
                  />
                </g>
                {isFork && <circle r="24" fill="none" stroke="rgb(var(--signal))" strokeOpacity=".35" className="pulse-dot" />}
              </g>
            );
          })}
        </svg>

        {/* origin */}
        <Dot x={ORIGIN_X} y={MAIN_Y} label="recorded activity" />

        {/* main-line stage nodes */}
        {stages.map((s, i) => {
          const reused = i < selIdx;
          const replaced = i >= selIdx && sim > 0;
          return (
            <GraphNode
              key={s.id}
              x={stageX(i)}
              y={MAIN_Y}
              onClick={() => onStage(s.id)}
              tone={replaced ? 'faded' : reused ? 'reused' : 'recorded'}
              title={s.name}
              index={i}
              tag={reused ? 'reused from snapshot' : i === selIdx ? 'replay starts here' : ''}
            />
          );
        })}
        <Dot x={END_X} y={MAIN_Y} label={`eval · ${run.metrics.qualityPassed}/${run.metrics.qualityTotal}`} />

        {/* snapshot label for fork */}
        <motion.div
          className="absolute w-[280px] text-center font-mono text-[16px] text-signal"
          style={{ top: MAIN_Y - 66 }}
          initial={false}
          animate={{ left: forkX - 140 }}
          transition={{ type: 'spring', stiffness: 260, damping: 28 }}
        >
          snapshot before {sel.name}
        </motion.div>

        {/* branch nodes */}
        <AnimatePresence>
          {downstream.map((s, k) => {
            const i = selIdx + k;
            const lit = sim >= k + 2;
            return (
              <GraphNode
                key={`br-${s.id}-${selIdx}`}
                x={stageX(i)}
                y={BRANCH_Y}
                tone={lit ? 'sim-lit' : 'sim'}
                title={s.name}
                index={i}
                tag={lit ? 'previewed' : 'pending'}
                appear
              />
            );
          })}
        </AnimatePresence>
        <motion.div
          className="absolute flex items-center gap-3"
          style={{ left: END_X - 9, top: BRANCH_Y - 9 }}
          initial={false}
          animate={{ opacity: sim >= lastSim ? 1 : 0.35 }}
        >
          <span className={`h-[18px] w-[18px] rounded-full border-2 ${sim >= lastSim ? 'border-signal bg-signal/30' : 'border-dashed border-ink-500'}`} />
        </motion.div>
        <motion.div
          className="absolute w-[280px] text-right font-mono text-[13px] text-ink-400"
          style={{ left: END_X - 270, top: BRANCH_Y + 52 }}
          animate={{ opacity: sim >= lastSim ? 1 : 0.4 }}
        >
          eval′ · replay not yet executed
        </motion.div>
      </div>

      {/* lower panels */}
      <div className="mt-6 grid flex-1 grid-cols-[1fr_1.25fr_1fr] gap-16 border-t border-ink-800 pt-8">
        {/* 1. choose */}
        <div>
          <Eyebrow size="xl">1 · Choose a stage</Eyebrow>
          <div className="mt-4 flex flex-col gap-2.5">
            {stages.map((s, i) => (
              <button
                key={s.id}
                onClick={() => onStage(s.id)}
                className={`flex items-center justify-between rounded-xl px-4 py-3 text-left transition ${
                  i === selIdx ? 'bg-ink-850 ring-1 ring-signal/50' : 'hover:bg-ink-900'
                }`}
              >
                <span className="flex items-center gap-3">
                  <span className="font-mono text-[13px] text-ink-400">{pad2(i + 1)}</span>
                  <span className={`text-[19px] ${i === selIdx ? 'text-ink-50' : 'text-ink-300'}`}>{s.name}</span>
                </span>
                <span className="font-mono text-[13px] text-ink-400">
                  {i < selIdx ? 'reuse' : i === selIdx ? 'fork ◆' : 're-run'}
                </span>
              </button>
            ))}
          </div>
          <Eyebrow size="xl" className="mt-8">Replay with config</Eyebrow>
          <div className="mt-3 flex gap-2.5">
            {experiment.runs.map((r) => (
              <button
                key={r.id}
                onClick={() => setConfigId(r.id)}
                className={`rounded-full border px-4 py-1.5 text-[17px] transition ${
                  configId === r.id ? 'border-signal/60 bg-signal/10 text-signal' : 'border-ink-700 text-ink-300 hover:text-ink-100'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* 2. plan */}
        <div>
          <Eyebrow size="xl">2 · Replay plan</Eyebrow>
          <ol className="mt-5 flex flex-col gap-7">
            <PlanStep n={1} active={sim >= 1} title={`Restore snapshot before ${sel.name}`} />
            <PlanStep n={2} active={sim >= 1} title={upstream.length ? `Reuse ${upstream.map((s) => s.name).join(', ')}` : 'Nothing upstream to reuse'} />
            <PlanStep n={3} active={sim >= 2} title={`Re-execute ${downstream.map((s) => s.name).join(' → ')}`} />
            <PlanStep n={4} active={sim >= lastSim} title={`Re-evaluate against ${run.metrics.qualityTotal} ground-truth checks`} />
          </ol>
        </div>

        {/* 3. outcome */}
        <div className="flex flex-col">
          <Eyebrow size="xl">3 · Outcome</Eyebrow>
          <div className="mt-3 space-y-3">
            <OutcomeRow label="Model requests reused">
              {reusedRequests !== null ? (
                <span className="tnum text-[44px] font-semibold leading-none text-signal">{reusedRequests}</span>
              ) : (
                <Missing size="sm" path="stages.*.modelRequests" />
              )}
            </OutcomeRow>
            <OutcomeRow label={lastRun ? 'Replay result · just run' : 'Replay result'}>
              {lastRun ? (
                <StageRunTable runs={[lastRun]} />
              ) : (
                <span className="text-[20px] leading-snug text-ink-200">Not run yet: this is a preview.</span>
              )}
            </OutcomeRow>
            <OutcomeRow label="Recorded stage runs">
              {stageRuns === null ? (
                <span className="font-mono text-[14.5px] text-ink-400">loading…</span>
              ) : recordedVariants > 0 ? (
                <button onClick={() => setRecordedOpen(true)} className="text-left text-[14px] text-signal hover:underline">
                  {recordedVariants} variants, {recordedRuns.filter((r) => r.usable).length} runs on {sel.name} →
                </button>
              ) : (
                <span className="text-[14px] text-ink-400">
                  None recorded for {sel.name}.
                </span>
              )}
            </OutcomeRow>
          </div>
          {/* Both buttons stay in view at any type size; what "Run Stage Replay" opens is a drawer over the
              page, not more height in this column. Nothing runs until the explicit Confirm inside it, and only
              when a saved snapshot has a step for this stage. Never fabricated. */}
          <div className="mt-auto flex flex-wrap items-center gap-3">
            <PrimaryButton size="xl" onClick={preview}>
              <PlayIcon /> {sim > 0 && sim < lastSim ? 'Previewing…' : 'Preview Replay Plan'}
            </PrimaryButton>
            {snapshots !== null && (
              <button
                onClick={() => {
                  loadSnapshots(); // re-check on every open, so a snapshot just added is picked up
                  setRealOpen(true);
                }}
                className="rounded-full border border-cost/60 px-5 py-3 text-[17px] font-semibold text-cost transition hover:bg-cost/10"
              >
                Run Stage Replay
              </button>
            )}
          </div>
          <p className="mt-2 font-mono text-[12px] uppercase tracking-[0.12em] text-ink-400">preview: simulation only · run: spends AI allowance</p>
          {snapshots !== null && realOpen && (
            <div className="absolute bottom-3 right-[120px] z-30 max-h-[880px] w-[600px] overflow-y-auto rounded-2xl bg-ink-950 p-3 shadow-2xl ring-1 ring-ink-700">
              {backendDown ? (
                <MissingPanel
              title="The pipeops server isn't reachable"
              onRecheck={loadSnapshots}
              onClose={() => setRealOpen(false)}
            >
              Run <code className="font-mono">npm run server</code> in <code className="font-mono">pipeops/</code>, then check again.
            </MissingPanel>
              ) : !match ? (
            <MissingPanel
              title={snapshots.length === 0 ? 'No saved snapshot on this machine' : `No saved snapshot has a step for ${sel.name}`}
              onRecheck={loadSnapshots}
              onClose={() => setRealOpen(false)}
            >
              <p>
                Put a snapshot in <code className="font-mono">eval/snapshots/&lt;id&gt;/</code> (local, not in git), then check again.
              </p>
              <ul className="mt-1.5 list-disc space-y-1 pl-5">
                <li>
                  From a teammate: <code className="font-mono">uv run wfeval pack snapshots/&lt;id&gt;</code>, then{' '}
                  <code className="font-mono">unzip &lt;id&gt;.zip</code> in <code className="font-mono">eval/</code>.
                </li>
                <li>
                  Or take one (spends allowance): <code className="font-mono">uv run wfeval snapshot --suite receipts --seed 1 --phases 1,2</code>
                </li>
              </ul>
            </MissingPanel>
              ) : (
            <div className="mt-4 rounded-xl border border-cost/30 p-3.5">
              <div className="flex items-center justify-between">
                <Eyebrow size="lg">Real execution</Eyebrow>
                <span className="rounded-full border border-cost/50 px-2 py-0.5 font-mono text-[12px] uppercase tracking-[0.12em] text-cost">
                  spends AI allowance
                </span>
              </div>
              <p className="mt-2 text-[15.5px] leading-relaxed text-ink-400">
                Replays {runChain ? downstream.map((x) => x.name).join(' → ') : `${sel.name} alone`} from{' '}
                <span className="text-ink-200">{match.snap.id}</span>
              </p>
              {throughTask && (
                <div className="mt-2 flex gap-2">
                  {[false, true].map((c) => (
                    <button
                      key={String(c)}
                      onClick={() => setChain(c)}
                      disabled={stageRunning}
                      className={`rounded-full border px-3 py-1 text-[14.5px] transition ${
                        chain === c ? 'border-signal/60 bg-signal/10 text-signal' : 'border-ink-700 text-ink-300 hover:text-ink-100'
                      }`}
                    >
                      {c ? `Through ${lastStage.name}` : `${sel.name} only`}
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-3">
                <Select size="lg"
                  value={realVariant}
                  onChange={setRealVariant}
                  options={variants.map((v) => ({ value: v.file, label: v.name }))}
                  disabled={stageRunning}
                  placeholder="choose a variant"
                  direction="up"
                />
              </div>
              {chosen && !chosen.engineReady && (
                <p className="mt-2 text-[14.5px] leading-relaxed text-cost">
                  This variant's engine isn't built here. Run <code className="font-mono">cd eval &amp;&amp; {chosen.setup}</code> first.
                </p>
              )}
              <div className="mt-3 flex items-center gap-3 rounded-xl border border-cost/40 bg-cost/[0.06] p-3">
                <span className="text-[14.5px] leading-snug text-cost">
                  Run {runChain ? downstream.map((x) => x.name).join(' → ') : sel.name} with “{chosen?.name}” for real? Takes a few minutes.
                </span>
                <PrimaryButton size="lg" className="shrink-0" onClick={runStageReplay} disabled={stageRunning || !chosen?.engineReady}>
                  {stageRunning ? 'Running…' : 'Confirm'}
                </PrimaryButton>
                {!stageRunning && (
                  <GhostButton size="lg" className="shrink-0" onClick={() => setRealOpen(false)}>
                    Cancel
                  </GhostButton>
                )}
              </div>
              {stageError && (
                <p className="mt-3 rounded-lg border border-cost/40 bg-cost/[0.06] p-2.5 text-[14.5px] leading-relaxed text-cost">{stageError}</p>
              )}
              {stageLog && (
                <details className="mt-3" open={stageRunning}>
                  <summary className="cursor-pointer font-mono text-[13px] text-ink-400">{stageError ? 'technical details' : 'live output'}</summary>
                  <div
                    ref={stageLogRef}
                    className="mt-2 h-32 overflow-y-auto rounded-lg border border-ink-700 bg-ink-950 p-2 font-mono text-[13px] text-ink-300"
                  >
                    <pre className="whitespace-pre-wrap">{stageLog}</pre>
                  </div>
                </details>
              )}
            </div>
              )}
            </div>
          )}

        </div>
      </div>
      {recordedOpen && recordedStage && (
        <div className="absolute inset-x-[120px] bottom-3 top-[120px] z-30 flex flex-col rounded-2xl border border-ink-700 bg-ink-950 p-6 shadow-2xl">
          <StageRunsTable runs={recordedRuns} variants={variants} regrades={regrades} title={recordedStage.includes('+') ? `${sel.name} → Review` : sel.name} onClose={() => setRecordedOpen(false)} />
        </div>
      )}
    </div>
  );
}

const rangeOf = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  if (!v.length) return '—';
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
};

/** The graded result of stage runs as each run recorded it (results.jsonl): checks, requests, seconds, calls
 *  the engine refused, and text the catalog saved shorter. A dash is "not recorded", never zero. */
function StageRunTable({ runs }: { runs: StageRunSummary[] }) {
  const short = (t: string) => t.replace(/^workflow-/, '');
  return (
    <div className="font-mono text-[14.5px]">
      <div className="grid grid-cols-[2fr_0.8fr_0.8fr_0.8fr_0.7fr_0.6fr] gap-x-2 pb-1 text-[12px] uppercase tracking-widest text-ink-400">
        <span>variant</span>
        <span title="checks passed in the graded view (drafts, or the catalog after Review)">checks</span>
        <span>requests</span>
        <span>seconds</span>
        <span title="Workflows calls the engine refused">rejected</span>
        <span title="fields the catalog saved shorter than Review published">clipped</span>
      </div>
      {runs.map((r) => (
        <div key={r.id} className="grid grid-cols-[2fr_0.8fr_0.8fr_0.8fr_0.7fr_0.6fr] gap-x-2 border-t border-ink-800 py-1 text-ink-200">
          <span className="truncate" title={r.id}>
            {r.variant ?? '?'}
            {r.tasks.length > 1 && <span className="text-ink-400"> · {r.tasks.map(short).join('→')}</span>}
          </span>
          <span className="tnum">{r.passed !== null && r.scored !== null ? `${r.passed}/${r.scored}` : '—'}</span>
          <span className="tnum">{rangeOf([r.requests])}</span>
          <span className="tnum">{rangeOf([r.seconds])}</span>
          <span className="tnum">{rangeOf([r.failedCalls])}</span>
          <span className="tnum">{r.view === 'catalog' ? rangeOf([r.clipped?.fields ?? null]) : '—'}</span>
        </div>
      ))}
    </div>
  );
}

/** What a real replay needs and does not have, and how to get it. Shown after the button is pressed. */
function MissingPanel({
  title,
  children,
  onRecheck,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onRecheck: () => void;
  onClose: () => void;
}) {
  return (
    <div className="mt-4 rounded-xl border border-cost/30 p-3.5">
      <Eyebrow>Real execution unavailable</Eyebrow>
      <div className="mt-2 text-[16.5px] font-medium text-ink-100">{title}</div>
      <div className="mt-2 text-[14.5px] leading-relaxed text-ink-400">{children}</div>
      <div className="mt-3 flex gap-2">
        <GhostButton onClick={onRecheck}>Check again</GhostButton>
        <GhostButton onClick={onClose}>Close</GhostButton>
      </div>
    </div>
  );
}

function Dot({ x, y, label }: { x: number; y: number; label: string }) {
  return (
    <>
      <span className="absolute h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink-200 bg-ink-950" style={{ left: x, top: y }} />
      <span className="absolute -translate-x-1/2 whitespace-nowrap font-mono text-[15px] text-ink-300" style={{ left: x, top: y + 20 }}>
        {label}
      </span>
    </>
  );
}

function GraphNode({
  x,
  y,
  title,
  index,
  tag,
  tone,
  onClick,
  appear,
}: {
  x: number;
  y: number;
  title: string;
  index: number;
  tag: string;
  tone: 'recorded' | 'reused' | 'faded' | 'sim' | 'sim-lit';
  onClick?: () => void;
  appear?: boolean;
}) {
  const cls = {
    recorded: 'border-ink-400 bg-ink-900 text-ink-50',
    reused: 'border-ink-500 bg-ink-900 text-ink-100',
    faded: 'border-ink-700 bg-ink-950 text-ink-400',
    sim: 'hatch-muted border-dashed border-ink-600 bg-ink-950 text-ink-400',
    'sim-lit': 'hatch border-signal bg-ink-900 text-ink-50 glow-signal',
  }[tone];
  return (
    <motion.button
      onClick={onClick}
      initial={appear ? { opacity: 0, y: -16 } : false}
      animate={{ opacity: 1, y: 0, scale: tone === 'sim-lit' ? 1.04 : 1 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.4, ease: EASE }}
      className={`absolute flex h-[80px] w-[250px] flex-col justify-center rounded-2xl border px-5 text-left transition-colors duration-300 ${cls}`}
      style={{ left: x - 125, top: y - 40 }}
    >
      <span className="flex items-center justify-between">
        <span className="text-[26px] font-semibold tracking-tight">{title}</span>
        <span className="font-mono text-[14px] opacity-60">{pad2(index + 1)}</span>
      </span>
      {tag && <span className="whitespace-nowrap font-mono text-[13px] uppercase tracking-[0.1em] opacity-70">{tag}</span>}
    </motion.button>
  );
}

function PlanStep({ n, title, active }: { n: number; title: string; active: boolean }) {
  return (
    <li className="flex items-center gap-4">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border font-mono text-[15px] transition-colors duration-300 ${
          active ? 'border-signal bg-signal text-on-signal' : 'border-ink-600 text-ink-400'
        }`}
      >
        {n}
      </span>
      <div className={`min-w-0 text-[21px] transition-colors ${active ? 'text-ink-50' : 'text-ink-200'}`}>{title}</div>
    </li>
  );
}

function OutcomeRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b border-ink-800 pb-6">
      <div className="font-mono text-[15px] uppercase tracking-widest text-ink-400">{label}</div>
      <div className="mt-3">{children}</div>
    </div>
  );
}
