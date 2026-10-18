import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Experiment, Run, StageId, WorkflowRecord } from '../data/schema';
import { ArrowRight, CountUp, Eyebrow, GhostButton, Missing, MissingBlock, PlayIcon, PrimaryButton } from '../components/ui';
import { fmtSeconds, pad2 } from '../lib/format';
import { usePlayKey } from '../lib/events';

/* ---------- geometry (canvas coordinates, 1380 × 800) ---------- */
const CW = 1380;
const CH = 770;
const STAGE_W = 280;
const STAGE_H = 170;
const STAGE_TOP = 214;
const stageCx = (i: number) => 20 + 167.5 + 335 * i;
const ACT = { cx: 690, top: 10, w: 560, h: 88 };
const WF = { cx: 690, top: 480, w: 1160, h: 96 };
const EV = { cx: 690, top: 636, w: 660, h: 124 };
const midY = STAGE_TOP + STAGE_H / 2;

const EDGES = [
  `M ${ACT.cx} ${ACT.top + ACT.h} C ${ACT.cx} 170, ${stageCx(0)} 150, ${stageCx(0)} ${STAGE_TOP}`,
  ...[0, 1, 2].map((i) => `M ${stageCx(i) + STAGE_W / 2} ${midY} L ${stageCx(i + 1) - STAGE_W / 2} ${midY}`),
  `M ${stageCx(3)} ${STAGE_TOP + STAGE_H} C ${stageCx(3)} 460, ${WF.cx} 430, ${WF.cx} ${WF.top}`,
  `M ${WF.cx} ${WF.top + WF.h} L ${EV.cx} ${EV.top}`,
];

/** phases: 0 idle · 1 activity · 2-5 stages · 6 workflows · 7 evaluation */
const LAST_PHASE = 7;
const PHASE_MS = 720;

type Sel = { kind: 'run' } | { kind: 'activity' } | { kind: 'stage'; id: StageId } | { kind: 'workflows' } | { kind: 'workflow'; id: string } | { kind: 'eval' };

export function CanvasView({
  experiment,
  run,
  onOpenEvidence,
  onReplayStage,
}: {
  experiment: Experiment;
  run: Run;
  onOpenEvidence: () => void;
  onReplayStage: (s: StageId) => void;
}) {
  const [phase, setPhase] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<Sel>({ kind: 'run' });
  const timer = useRef<number | null>(null);

  const play = useCallback(() => {
    if (timer.current) window.clearInterval(timer.current);
    setPhase(0);
    setPlaying(true);
    let p = 0;
    timer.current = window.setInterval(() => {
      p += 1;
      setPhase(p);
      if (p >= LAST_PHASE) {
        window.clearInterval(timer.current!);
        timer.current = null;
        setPlaying(false);
      }
    }, PHASE_MS);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(play, 350);
    return () => {
      window.clearTimeout(t);
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [play, run.id]);

  usePlayKey(play);

  const stages = experiment.stages;
  const done = phase >= LAST_PHASE;

  return (
    <div className="flex h-full">
      {/* ---------------- canvas ---------------- */}
      <div className="relative flex flex-1 flex-col px-10 pt-6">
        <div className="flex items-center justify-between">
          <div className="text-[25px] font-medium tracking-tight text-ink-100">
            How recorded activity becomes evaluated workflows
          </div>
        </div>

        <div className="relative mx-auto mt-4" style={{ width: CW, height: CH }}>
          {/* edges */}
          <svg width={CW} height={CH} className="pointer-events-none absolute inset-0 overflow-visible">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 1 L9 5 L0 9" fill="none" stroke="rgb(var(--ink-400))" strokeWidth="1.4" />
              </marker>
              <marker id="arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 1 L9 5 L0 9" fill="none" stroke="rgb(var(--signal))" strokeWidth="1.4" />
              </marker>
              <filter id="edge-glow" filterUnits="userSpaceOnUse" x="-50" y="-50" width={CW + 100} height={CH + 100}>
                <feGaussianBlur stdDeviation="4" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {EDGES.map((d, i) => {
              const lit = phase >= i + 2;
              return (
                <g key={i}>
                  <path d={d} stroke="rgb(var(--ink-600))" strokeWidth="1.5" fill="none" markerEnd="url(#arrow)" />
                  <motion.path
                    d={d}
                    stroke="rgb(var(--signal))"
                    strokeWidth="2"
                    fill="none"
                    filter="url(#edge-glow)"
                    markerEnd={lit ? 'url(#arrow-on)' : undefined}
                    initial={false}
                    animate={{ pathLength: lit ? 1 : 0, opacity: lit ? 0.9 : 0 }}
                    transition={{ duration: PHASE_MS / 1000 - 0.1, ease: 'easeInOut' }}
                  />
                </g>
              );
            })}
          </svg>

          {/* travelling signal along the edge being traversed */}
          <AnimatePresence>
            {phase >= 2 && phase <= LAST_PHASE && playing && (
              <motion.div
                key={`p-${phase}`}
                className="pointer-events-none absolute left-0 top-0 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-signal shadow-[0_0_18px_6px_rgb(var(--signal)/0.55)]"
                style={{ offsetPath: `path('${EDGES[phase - 2]}')`, offsetRotate: '0deg' } as React.CSSProperties}
                initial={{ offsetDistance: '0%', opacity: 1 } as never}
                animate={{ offsetDistance: '100%', opacity: 1 } as never}
                exit={{ opacity: 0 }}
                transition={{ duration: PHASE_MS / 1000 - 0.1, ease: 'easeInOut' }}
              />
            )}
          </AnimatePresence>

          {/* pipeline enclosure */}
          <div
            className="absolute rounded-[28px] border border-ink-700/80 bg-ink-900/30"
            style={{ left: 20, top: 168, width: 1340, height: 252 }}
          >
            <div className="absolute -top-3 left-8 bg-ink-950 px-3 font-mono text-[13px] uppercase tracking-[0.18em] text-ink-400">
              Agent pipeline · {stages.length} stages
            </div>
          </div>

          {/* recorded activity */}
          <Node
            style={{ left: ACT.cx - ACT.w / 2, top: ACT.top, width: ACT.w, height: ACT.h }}
            state={phase === 1 ? 'active' : phase > 1 ? 'done' : 'idle'}
            selected={sel.kind === 'activity'}
            onClick={() => setSel({ kind: 'activity' })}
          >
            <div className="flex h-full items-center justify-between px-6">
              <div>
                <div className="font-mono text-[13px] uppercase tracking-[0.18em] text-ink-400">input</div>
                <div className="mt-1 text-[23px] font-medium text-ink-50">Recorded activity</div>
              </div>
              {run.recordedActivity && (
                <span className="text-[15.5px] text-ink-300">{run.recordedActivity.description}</span>
              )}
            </div>
          </Node>

          {/* stages */}
          {stages.map((s, i) => {
            const p = i + 2;
            const rec = run.stages[s.id];
            return (
              <Node
                key={s.id}
                style={{ left: stageCx(i) - STAGE_W / 2, top: STAGE_TOP, width: STAGE_W, height: STAGE_H }}
                state={phase === p ? 'active' : phase > p ? 'done' : 'idle'}
                selected={sel.kind === 'stage' && sel.id === s.id}
                onClick={() => setSel({ kind: 'stage', id: s.id })}
              >
                <div className="flex h-full flex-col p-5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[14.5px] text-ink-400">{pad2(i + 1)}</span>
                    <StageStatus phase={phase} p={p} />
                  </div>
                  <div className="mt-2 text-[34px] font-semibold tracking-tight text-ink-50">{s.name}</div>
                  <div className="mt-1 text-[15.5px] leading-snug text-ink-400">{s.summary}</div>
                  <div className="mt-auto flex items-center gap-5 font-mono text-[14.5px] text-ink-400">
                    <span>req <span className="text-ink-50">{rec?.modelRequests ?? <DashVal />}</span></span>
                    <span>time <span className="text-ink-50">{rec?.runtimeSeconds != null ? `${rec.runtimeSeconds}s` : <DashVal />}</span></span>
                  </div>
                </div>
              </Node>
            );
          })}

          {/* generated workflows: each is clickable and opens its full detail in the inspector */}
          <motion.div
            className={`absolute flex items-center gap-5 rounded-2xl border px-5 ${
              phase === 6 ? 'glow-signal border-signal bg-ink-850' : phase > 6 ? 'border-ink-500 bg-ink-900' : 'border-ink-700 bg-ink-900/70'
            } ${sel.kind === 'workflows' ? 'ring-1 ring-ink-100 ring-offset-4 ring-offset-ink-950' : ''}`}
            style={{ left: WF.cx - WF.w / 2, top: WF.top, width: WF.w, height: WF.h }}
            animate={{ scale: phase === 6 ? 1.02 : 1, opacity: phase < 6 ? 0.6 : 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 24 }}
          >
            <button onClick={() => setSel({ kind: 'workflows' })} className="w-[190px] shrink-0 text-left">
              <div className="font-mono text-[13px] uppercase tracking-[0.18em] text-ink-400">output</div>
              <div className="mt-1 flex items-baseline gap-2.5">
                <span className="text-[23px] font-medium text-ink-50">Workflows</span>
                {run.generatedWorkflows && (
                  <span className="tnum text-[32px] font-semibold text-ink-50">{run.generatedWorkflows.length}</span>
                )}
              </div>
              {run.generatedWorkflows && <div className="mt-1 font-mono text-[12px] text-ink-400">click one to inspect</div>}
            </button>
            {run.generatedWorkflows ? (
              <div className="flex min-w-0 flex-1 items-stretch gap-3">
                {run.generatedWorkflows.slice(0, 3).map((w) => (
                  <button
                    key={w.id}
                    onClick={() => setSel({ kind: 'workflow', id: w.id })}
                    className={`min-w-0 flex-1 rounded-xl border px-4 py-2.5 text-left transition-colors hover:border-signal/70 ${
                      sel.kind === 'workflow' && sel.id === w.id ? 'border-signal bg-signal/[0.06]' : 'border-ink-700 bg-ink-950/40'
                    }`}
                  >
                    <div className="line-clamp-2 text-[15.5px] font-medium leading-snug text-ink-100">{w.title}</div>
                  </button>
                ))}
                {run.generatedWorkflows.length > 3 && (
                  <button
                    onClick={() => setSel({ kind: 'workflows' })}
                    className="shrink-0 self-center rounded-full border border-ink-700 px-3 py-1 font-mono text-[13px] text-ink-300 hover:border-ink-400"
                  >
                    +{run.generatedWorkflows.length - 3} more
                  </button>
                )}
              </div>
            ) : (
              <Missing size="sm" path="generatedWorkflows" />
            )}
          </motion.div>

          {/* evaluation — score stays sealed until Step 03; requests/runtime are execution facts, not the score */}
          <Node
            style={{ left: EV.cx - EV.w / 2, top: EV.top, width: EV.w, height: EV.h }}
            state={phase === 7 ? 'active' : 'idle'}
            selected={sel.kind === 'eval'}
            onClick={() => setSel({ kind: 'eval' })}
          >
            <div className="flex h-full items-center gap-6 px-6">
              <div className="relative flex h-[96px] w-[96px] items-center justify-center rounded-full border border-dashed border-ink-600">
                <span className="font-mono text-[12px] uppercase tracking-widest text-ink-400">sealed</span>
              </div>
              <div className="flex-1">
                <div className="font-mono text-[13px] uppercase tracking-[0.18em] text-ink-400">evaluation vs ground truth</div>
                <div className="mt-1 text-[23px] text-ink-300">
                  {done ? 'Ready · see step 03' : 'awaiting run…'}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 font-mono text-[15.5px]">
                <span className="text-ink-400">
                  requests{' '}
                  <span className="text-ink-100">{done ? <CountUp value={run.metrics.modelRequests} /> : '··'}</span>
                </span>
                <span className="text-ink-400">
                  runtime{' '}
                  <span className="text-ink-100">
                    {done ? <CountUp value={run.metrics.runtimeSeconds} format={(n) => `${Math.round(n)}s`} /> : '··'}
                  </span>
                </span>
              </div>
            </div>
          </Node>
        </div>

        {/* playback controls */}
        <div className="absolute bottom-5 left-10 flex items-center gap-5">
          <PrimaryButton size="lg" onClick={play}>
            <PlayIcon /> {playing ? 'Replaying…' : 'Replay recording'}
          </PrimaryButton>
          <div className="flex items-center gap-1.5">
            {Array.from({ length: LAST_PHASE }, (_, i) => (
              <button
                key={i}
                onClick={() => {
                  if (timer.current) window.clearInterval(timer.current);
                  setPlaying(false);
                  setPhase(i + 1);
                }}
                className={`h-1.5 rounded-full transition-all ${phase >= i + 1 ? 'w-8 bg-signal' : 'w-5 bg-ink-700 hover:bg-ink-500'}`}
                aria-label={`Jump to phase ${i + 1}`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ---------------- inspector ---------------- */}
      <aside className="w-[460px] shrink-0 border-l border-ink-800 bg-ink-950/70 backdrop-blur">
        <AnimatePresence mode="wait">
          <motion.div
            key={JSON.stringify(sel) + run.id}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.25 }}
            className="h-full overflow-hidden px-9 py-8"
          >
            <Inspector
              sel={sel}
              run={run}
              experiment={experiment}
              onBack={() => setSel({ kind: 'run' })}
              onOpenEvidence={onOpenEvidence}
              onReplayStage={onReplayStage}
              onSelectWorkflow={(id) => setSel(id ? { kind: 'workflow', id } : { kind: 'workflows' })}
            />
          </motion.div>
        </AnimatePresence>
      </aside>
    </div>
  );
}

function DashVal() {
  return <span className="text-ink-500">—</span>;
}

function StageStatus({ phase, p }: { phase: number; p: number }) {
  if (phase === p)
    return (
      <span className="flex items-center gap-1.5 font-mono text-[13px] uppercase tracking-widest text-signal">
        <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-signal" /> playing
      </span>
    );
  if (phase > p) return <span className="font-mono text-[15px] text-signal">✓</span>;
  return <span className="font-mono text-[13px] uppercase tracking-widest text-ink-500">queued</span>;
}

function Node({
  children,
  style,
  state,
  selected,
  onClick,
}: {
  children: ReactNode;
  style: React.CSSProperties;
  state: 'idle' | 'active' | 'done';
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      onClick={onClick}
      className={`absolute rounded-2xl border text-left transition-colors ${
        state === 'active'
          ? 'glow-signal border-signal bg-ink-850'
          : state === 'done'
            ? 'border-ink-500 bg-ink-900'
            : 'border-ink-700 bg-ink-900/70'
      } ${selected ? 'ring-1 ring-ink-100 ring-offset-4 ring-offset-ink-950' : ''} hover:border-ink-300`}
      style={style}
      animate={{ scale: state === 'active' ? 1.03 : 1, opacity: state === 'idle' ? 0.6 : 1 }}
      transition={{ type: 'spring', stiffness: 300, damping: 24 }}
    >
      {children}
    </motion.button>
  );
}

/* ---------------- inspector content ---------------- */

function Inspector({
  sel,
  run,
  experiment,
  onBack,
  onOpenEvidence,
  onReplayStage,
  onSelectWorkflow,
}: {
  sel: Sel;
  run: Run;
  experiment: Experiment;
  onBack: () => void;
  onOpenEvidence: () => void;
  onReplayStage: (s: StageId) => void;
  onSelectWorkflow: (id: string) => void;
}) {
  const back = (
    <button onClick={onBack} className="mb-6 font-mono text-[13px] uppercase tracking-widest text-ink-400 hover:text-ink-200">
      ← run overview
    </button>
  );

  if (sel.kind === 'run') {
    return (
      <div className="flex h-full flex-col">
        <Eyebrow size="lg">Inspector · run</Eyebrow>
        <div className="mt-3 truncate whitespace-nowrap text-[34px] font-semibold tracking-tight text-ink-50" title={run.label}>
          {run.label}
        </div>
        {/* The three blocks share the remaining height with equal gaps between them. */}
        <div className="mt-6 flex flex-1 flex-col justify-evenly">
          <div className="border-t border-ink-800">
            <BigStat label="model requests" value={<CountUp value={run.metrics.modelRequests} />} />
          </div>
          <div className="border-t border-ink-800">
            <BigStat
              label="runtime"
              value={<CountUp value={run.metrics.runtimeSeconds} format={(n) => `${Math.round(n)}s`} />}
              sub={fmtSeconds(run.metrics.runtimeSeconds)}
            />
          </div>
          <div className="border-t border-ink-800 pt-5">
          <Eyebrow size="xl">Per-stage breakdown</Eyebrow>
          <div className="mt-4 space-y-3.5">
            {experiment.stages.map((s) => (
              <div key={s.id} className="flex items-baseline justify-between text-[22px]">
                <span className="text-ink-100">{s.name}</span>
                {run.stages[s.id]?.modelRequests != null ? (
                  <span className="tnum font-mono">
                    <span className="text-[26px] font-semibold text-signal">{run.stages[s.id].modelRequests}</span>{' '}
                    <span className="text-[17px] text-ink-400">req</span>
                  </span>
                ) : (
                  <Missing size="sm" path={`stages.${s.id}.modelRequests`} />
                )}
              </div>
            ))}
          </div>
          </div>
        </div>
      </div>
    );
  }

  if (sel.kind === 'stage') {
    const i = experiment.stages.findIndex((s) => s.id === sel.id);
    const s = experiment.stages[i];
    const rec = run.stages[s.id];
    const base = `runs[${run.id}].stages.${s.id}`;
    return (
      <div className="flex h-full flex-col">
        {back}
        <Eyebrow size="lg">
          Stage {pad2(i + 1)} / {pad2(experiment.stages.length)}
        </Eyebrow>
        <div className="mt-2 text-[60px] font-semibold leading-none tracking-tightest text-ink-50">{s.name}</div>
        <p className="mt-4 text-[19px] leading-relaxed text-ink-300">{s.summary}</p>
        <div className="mt-8 space-y-4">
          <Field label="Model requests" value={rec?.modelRequests} path={`${base}.modelRequests`} />
          <Field label="Runtime" value={rec?.runtimeSeconds != null ? `${rec.runtimeSeconds}s` : null} path={`${base}.runtimeSeconds`} />
          {/* Snapshots exist only for stage replays, so the row is simply omitted when absent. */}
          {rec?.snapshotId != null && <Field label="Saved snapshot" value={rec.snapshotId} path={`${base}.snapshotId`} />}
          <div className="flex min-h-0 flex-col gap-1.5">
            <span className="font-mono text-[13px] uppercase tracking-widest text-ink-400">Agent's own summary</span>
            {rec?.output != null ? (
              <p className="max-h-[200px] overflow-y-auto whitespace-pre-wrap pr-1 text-[15.5px] leading-relaxed text-ink-200">{rec.output}</p>
            ) : (
              <Missing path={`${base}.output`} />
            )}
          </div>
        </div>
        <div className="mt-auto rounded-2xl border border-signal/30 bg-signal/[0.04] p-5">
          <div className="text-[17.5px] font-medium text-ink-50">Debug this stage in isolation</div>
          <p className="mt-1.5 text-[15.5px] leading-relaxed text-ink-400">
            Branch a replay from the snapshot saved before {s.name}. Upstream stages are reused, not re-run.
          </p>
          <PrimaryButton size="lg" className="mt-4" onClick={() => onReplayStage(s.id)}>
            Replay from {s.name} <ArrowRight />
          </PrimaryButton>
        </div>
      </div>
    );
  }

  if (sel.kind === 'activity') {
    return (
      <div className="flex h-full flex-col">
        {back}
        <Eyebrow size="lg">Input</Eyebrow>
        <div className="mt-2 text-[48px] font-semibold leading-none tracking-tight text-ink-50">Recorded activity</div>
        <p className="mt-4 text-[17.5px] leading-relaxed text-ink-300">
          The captured user session the agent reads to discover workflows.
        </p>
        <div className="mt-8">
          {run.recordedActivity && <p className="text-ink-200">{run.recordedActivity.description}</p>}
        </div>
      </div>
    );
  }

  if (sel.kind === 'workflows') {
    return (
      <div className="flex h-full flex-col">
        {back}
        <Eyebrow size="lg">Output</Eyebrow>
        <div className="mt-2 text-[48px] font-semibold leading-none tracking-tight text-ink-50">Generated workflows</div>
        <p className="mt-4 text-[17.5px] leading-relaxed text-ink-300">Reusable workflows the agent produced for this run.</p>
        <div className="mt-8 space-y-3 overflow-y-auto">
          {run.generatedWorkflows ? (
            run.generatedWorkflows.map((w) => (
              <button
                key={w.id}
                onClick={() => onSelectWorkflow(w.id)}
                className="block w-full rounded-xl border border-ink-700 p-4 text-left transition-colors hover:border-signal/70"
              >
                <div className="text-[17.5px] font-medium text-ink-100">{w.title}</div>
                {w.confidence != null && (
                  <div className="mt-1 font-mono text-[13px] text-ink-400">confidence {w.confidence}/4</div>
                )}
                {w.trigger && (
                  <p className="mt-3 line-clamp-2 text-[15.5px] leading-relaxed text-ink-300">
                    <span className="text-ink-400">trigger · </span>
                    {w.trigger}
                  </p>
                )}
                {w.outcome && (
                  <p className="mt-2 line-clamp-2 text-[15.5px] leading-relaxed text-ink-300">
                    <span className="text-ink-400">outcome · </span>
                    {w.outcome}
                  </p>
                )}
                {w.variations && (
                  <p className="mt-2 line-clamp-2 text-[14.5px] leading-relaxed text-ink-400">
                    <span className="text-ink-400">variations · </span>
                    {w.variations.join(' · ')}
                  </p>
                )}
                {w.limitations && (
                  <p className="mt-2 line-clamp-2 text-[14.5px] leading-relaxed text-ink-400">
                    <span className="text-ink-400">limitations · </span>
                    {w.limitations.join(' · ')}
                  </p>
                )}
                <div className="mt-3 font-mono text-[13px] text-ink-400">view full workflow →</div>
              </button>
            ))
          ) : (
            <MissingBlock title="Workflow list, titles and steps" path={`runs[${run.id}].generatedWorkflows`}>
              <div className="mt-4 space-y-2 opacity-60">
                {[0.9, 0.7, 0.8].map((w, k) => (
                  <div key={k} className="h-9 rounded-lg border border-dashed border-ink-700" style={{ width: `${w * 100}%` }} />
                ))}
              </div>
            </MissingBlock>
          )}
        </div>
        <GhostButton size="lg" className="mt-auto self-start" onClick={onOpenEvidence}>
          Match against ground truth <ArrowRight />
        </GhostButton>
      </div>
    );
  }

  if (sel.kind === 'workflow') {
    const w = run.generatedWorkflows?.find((x) => x.id === sel.id);
    if (!w) return <div className="flex h-full flex-col">{back}</div>;
    return <WorkflowDetail w={w} run={run} onBack={() => onSelectWorkflow('')} onOpenEvidence={onOpenEvidence} />;
  }

  // eval — Step 02 is "what did the agents do", not "did they pass": the score stays
  // sealed here and reveals in Inspect Evaluation (Step 03), on purpose.
  return (
    <div className="flex h-full flex-col">
      {back}
      <Eyebrow size="lg">Evaluation</Eyebrow>
      <div className="mt-6 flex h-[150px] w-[150px] items-center justify-center rounded-full border border-dashed border-ink-600">
        <span className="font-mono text-[13px] uppercase tracking-widest text-ink-400">sealed</span>
      </div>
      <p className="mt-8 text-[17.5px] leading-relaxed text-ink-300">
        Each check compares the generated workflows with known ground truth — the result is revealed in Step 03, not
        here.
      </p>
      <PrimaryButton size="lg" className="mt-6 self-start" onClick={onOpenEvidence}>
        Open evidence explorer <ArrowRight />
      </PrimaryButton>
    </div>
  );
}

function BigStat({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="flex items-end justify-between py-5">
      <span className="font-mono text-[13px] uppercase tracking-widest text-ink-400">{label}</span>
      <span className="text-right">
        <span className="tnum block text-[56px] font-semibold leading-none tracking-tightest text-signal">{value}</span>
        {sub && <span className="mt-1 block font-mono text-[14.5px] text-ink-400">{sub}</span>}
      </span>
    </div>
  );
}

function Field({ label, value, path }: { label: string; value: string | number | null | undefined; path: string }) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-ink-800 pb-4">
      <span className="font-mono text-[13px] uppercase tracking-widest text-ink-400">{label}</span>
      {value != null ? <span className="text-[21px] text-ink-50">{value}</span> : <Missing path={path} />}
    </div>
  );
}

/** Full detail of one generated workflow, read straight from the run's catalog fields.
 *  Absent fields render the standard labelled placeholder, nothing is filled in. */
function WorkflowDetail({
  w,
  run,
  onBack,
  onOpenEvidence,
}: {
  w: WorkflowRecord;
  run: Run;
  onBack: () => void;
  onOpenEvidence: () => void;
}) {
  const base = `runs[${run.id}].generatedWorkflows[${w.id}]`;
  const matched = run.groundTruth?.find((g) => g.id === w.matchedTo);
  const list = (items: string[] | null | undefined, path: string, numbered = false) =>
    items?.length ? (
      <ul className="mt-2 space-y-2">
        {items.map((t, i) => (
          <li key={i} className="flex gap-3 text-[15.5px] leading-relaxed text-ink-200">
            <span className="mt-0.5 shrink-0 font-mono text-[13px] text-ink-400">{numbered ? pad2(i + 1) : '·'}</span>
            {t}
          </li>
        ))}
      </ul>
    ) : (
      <div className="mt-2">
        <Missing size="sm" path={path} />
      </div>
    );
  return (
    <div className="flex h-full flex-col">
      <button onClick={onBack} className="mb-6 self-start font-mono text-[13px] uppercase tracking-widest text-ink-400 hover:text-ink-200">
        ← all workflows
      </button>
      <Eyebrow size="lg">Generated workflow</Eyebrow>
      <div className="mt-2 text-[27px] font-semibold leading-snug tracking-tight text-ink-50">{w.title}</div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {w.confidence != null ? (
          <span className="flex items-center gap-2 font-mono text-[13px] text-ink-400">
            confidence
            <span className="flex gap-1">
              {[1, 2, 3, 4].map((n) => (
                <span key={n} className={`h-1.5 w-5 rounded-full ${n <= w.confidence! ? 'bg-signal' : 'bg-ink-700'}`} />
              ))}
            </span>
            <span className="text-ink-200">{w.confidence}/4</span>
          </span>
        ) : (
          <Missing size="sm" path={`${base}.confidence`} />
        )}
        {matched && (
          <span className="rounded-full border border-ink-600 px-2.5 py-0.5 font-mono text-[12.5px] text-ink-300" title="Pairing made by the grader in Step 03, not by an agent">
            graded as: {matched.title}
          </span>
        )}
      </div>

      <div className="mt-5 min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
        <Section label="Trigger">{w.trigger ? <p className="mt-2 text-[15.5px] leading-relaxed text-ink-200">{w.trigger}</p> : <div className="mt-2"><Missing size="sm" path={`${base}.trigger`} /></div>}</Section>
        <Section label="Outcome">{w.outcome ? <p className="mt-2 text-[15.5px] leading-relaxed text-ink-200">{w.outcome}</p> : <div className="mt-2"><Missing size="sm" path={`${base}.outcome`} /></div>}</Section>
        <Section label={`Steps${w.steps ? ` · ${w.steps.length}` : ''}`}>{list(w.steps, `${base}.steps`, true)}</Section>
        <Section label="Variations">{list(w.variations, `${base}.variations`)}</Section>
        <Section label="Limitations">{list(w.limitations, `${base}.limitations`)}</Section>
      </div>

      <p className="mt-4 text-[14.5px] leading-relaxed text-ink-400">
        The run's artifacts record the pipeline's final catalog, not which agent wrote each field, so none is attributed to one.
      </p>
      <GhostButton size="lg" className="mt-3 self-start" onClick={onOpenEvidence}>
        Match against ground truth <ArrowRight />
      </GhostButton>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t border-ink-800 pt-4">
      <span className="font-mono text-[13px] uppercase tracking-widest text-ink-400">{label}</span>
      {children}
    </div>
  );
}
