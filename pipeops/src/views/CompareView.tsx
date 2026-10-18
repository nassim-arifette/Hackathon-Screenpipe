import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Efficiency, Experiment, PairReview, PhaseResult, Run } from '../data/schema';
import { fetchStageRegrades, fetchStageRuns, fetchVariants, type StageRegrades, type StageRun, type VariantSummary } from '../data/live';
import { StageRunsTable, checksText } from '../components/StageRunsTable';
import { CountUp, Eyebrow, Kbd, PlayIcon, PrimaryButton, Select } from '../components/ui';
import { cacheHitRate, fmtCount, totalTokens } from '../lib/efficiency';
import { fmtSeconds, pct } from '../lib/format';
import { usePlayKey } from '../lib/events';
import { ANIMATED, useTheme } from '../lib/theme';

type Mode = 'A' | 'B' | 'AB';
type View = 'full' | 'stage';
const VIZ_W = 1000;
const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '±');
const signedPct = (from: number, to: number) => `${sign(to - from)}${Math.abs(pct(from, to)).toFixed(1)}%`;
const EASE = [0.22, 1, 0.36, 1] as const;

export function CompareView({ experiment }: { experiment: Experiment }) {
  const a = experiment.runs.find((r) => r.id === experiment.comparison.baseline)!;
  const b = experiment.runs.find((r) => r.id === experiment.comparison.variant)!;
  const [view, setView] = useState<View>('full');
  const [mode, setMode] = useState<Mode>('A');
  const [revealed, setRevealed] = useState(false);
  const [running, setRunning] = useState(false);
  const timers = useRef<number[]>([]);

  const clear = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => clear, []);

  const reveal = () => {
    clear();
    setRevealed(false);
    setRunning(true);
    setMode('A');
    const at = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));
    at(900, () => setMode('B'));
    at(3100, () => setMode('AB'));
    at(4300, () => {
      setRevealed(true);
      setRunning(false);
    });
  };
  usePlayKey(() => {
    if (view === 'full') reveal();
  });

  const shown = mode === 'A' ? a : b;
  const showDelta = mode === 'AB';
  const qualityDelta = b.metrics.qualityPassed - a.metrics.qualityPassed;
  const reqDelta = b.metrics.modelRequests - a.metrics.modelRequests;
  const secDelta = b.metrics.runtimeSeconds - a.metrics.runtimeSeconds;
  const tokA = totalTokens(a.efficiency);
  const tokB = totalTokens(b.efficiency);
  const tokShown = totalTokens(shown.efficiency);
  const phaseRows = pairPhases(a, b);
  const extras = Boolean(phaseRows || experiment.comparison.review);

  return (
    <div className="flex h-full flex-col px-[120px] pt-9">
      {/* ---------- header ---------- */}
      <div className="flex items-end justify-between">
        {view === 'full' ? (
          <div>
            <Eyebrow size="lg">Experiment comparison · {experiment.experiment.question}</Eyebrow>
            <div className="mt-3 flex items-baseline gap-5 text-[56px] font-semibold leading-none tracking-tightest">
              <span className={mode === 'B' ? 'text-ink-400 transition-colors' : 'text-ink-50 transition-colors'}>{a.label}</span>
              <span className="text-[36px] font-normal text-ink-500">vs</span>
              <span className={mode === 'A' ? 'text-ink-400 transition-colors' : 'text-ink-50 transition-colors'}>{b.label}</span>
            </div>
          </div>
        ) : (
          <div>
            <Eyebrow size="lg">Variant comparison · one agent, from a saved snapshot</Eyebrow>
            <div className="mt-3 text-[56px] font-semibold leading-none tracking-tightest text-ink-50">Stage runs</div>
          </div>
        )}
        <div className="flex items-center gap-4">
          <ViewTabs view={view} onView={(v) => { clear(); setRunning(false); setView(v); }} />
          {view === 'full' && (
            <>
              <ModeSwitch mode={mode} a={a} b={b} onMode={(m) => { clear(); setRunning(false); setMode(m); if (m === 'AB') setRevealed(true); }} />
              <PrimaryButton size="lg" onClick={reveal}>
                <PlayIcon /> {running ? 'Running reveal…' : revealed ? 'Replay reveal' : 'Run reveal'}
              </PrimaryButton>
            </>
          )}
        </div>
      </div>
      {view === 'stage' && <StageRunsView />}
      {view === 'full' && (
        <>

      {/* ---------- lanes ---------- */}
      <div className="mt-7 flex flex-col border-t border-ink-800">
        <Lane
          label="Quality"
          sub="checks passed vs ground truth"
          viz={<QualityViz a={a} b={b} mode={mode} />}
          value={
            <span className="tnum">
              {shown.metrics.qualityPassed}
              <span className="text-ink-400">/{shown.metrics.qualityTotal}</span>
            </span>
          }
          delta={
            showDelta ? (
              <DeltaChip tone={qualityDelta < 0 ? 'cost' : 'neutral'}>{qualityDelta === 0 ? '±0 · unchanged' : `${sign(qualityDelta)}${Math.abs(qualityDelta)} checks`}</DeltaChip>
            ) : null
          }
          tone={mode !== 'A' && qualityDelta < 0 ? 'cost' : undefined}
        />
        <Lane
          label="Model requests"
          sub="1 tick = 1 request"
          viz={<RequestsViz ra={a.metrics.modelRequests} rb={b.metrics.modelRequests} mode={mode} />}
          value={<CountUp value={shown.metrics.modelRequests} duration={1.4} />}
          delta={
            showDelta ? (
              <DeltaChip tone={reqDelta > 0 ? 'cost' : 'neutral'}>
                {sign(reqDelta)}{Math.abs(reqDelta)} · {signedPct(a.metrics.modelRequests, b.metrics.modelRequests)}
              </DeltaChip>
            ) : null
          }
          tone={mode !== 'A' && reqDelta > 0 ? 'cost' : undefined}
        />
        {/* Hidden when neither run recorded usage: a row of dashes reads as a bug in a demo. */}
        {(a.efficiency || b.efficiency) && (
          <Lane
            label="Token usage"
            height={146}
            sub="input · cache · output"
            viz={<TokensViz a={a} b={b} mode={mode} />}
            value={tokShown === null ? <span className="text-ink-500">—</span> : <CountUp value={tokShown} duration={1.6} format={(n) => fmtCount(Math.round(n)) ?? '—'} />}
            valueSub={tokShown === null ? 'not recorded' : 'total tokens'}
            delta={
              showDelta && tokA !== null && tokB !== null && tokA > 0 ? (
                <DeltaChip tone={tokB > tokA ? 'cost' : 'neutral'}>
                  {sign(tokB - tokA)}
                  {fmtCount(Math.abs(tokB - tokA))} · {signedPct(tokA, tokB)}
                </DeltaChip>
              ) : null
            }
            tone={mode !== 'A' && tokShown !== null && tokA !== null && tokB !== null && tokB > tokA ? 'cost' : undefined}
          />
        )}
        <Lane
          label="Runtime"
          sub="wall-clock seconds"
          viz={<RuntimeViz sa={a.metrics.runtimeSeconds} sb={b.metrics.runtimeSeconds} mode={mode} />}
          value={<CountUp value={shown.metrics.runtimeSeconds} duration={1.8} format={(n) => `${Math.round(n)}s`} />}
          valueSub={fmtSeconds(shown.metrics.runtimeSeconds)}
          delta={
            showDelta ? (
              <DeltaChip tone={secDelta > 0 ? 'cost' : 'neutral'}>
                {sign(secDelta)}{Math.abs(secDelta)}s · {signedPct(a.metrics.runtimeSeconds, b.metrics.runtimeSeconds)}
              </DeltaChip>
            ) : null
          }
          tone={mode !== 'A' && secDelta > 0 ? 'cost' : undefined}
        />
      </div>

      {/* ---------- verdict ---------- */}
      <div className="relative mt-6 flex-1">
        <AnimatePresence mode="wait">
          {revealed ? (
            <motion.div
              key="verdict"
              initial={{ opacity: 0, y: 24, filter: 'blur(10px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.9, ease: EASE }}
              className="flex items-start gap-8"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <Eyebrow size="lg" className="text-signal">Conclusion</Eyebrow>
                  <span className="rounded-full border border-ink-700 px-2.5 py-0.5 font-mono text-[12px] uppercase tracking-widest text-ink-400">
                    n = {experiment.comparison.pairing === 'single' ? 1 : '>1'} pair
                  </span>
                </div>
                <div
                  className={`mt-2 font-semibold tracking-tightest text-ink-50 ${
                    extras ? 'text-[40px] leading-[1.05]' : experiment.comparison.verdict.length > 40 ? 'text-[56px] leading-[1]' : 'text-[84px] leading-[0.95]'
                  }`}
                >
                  {experiment.comparison.verdict}
                </div>
                <p className={`mt-3 text-ink-300 ${extras ? 'text-[17.5px] leading-snug' : 'text-[21px]'}`}>
                  {a.metrics.qualityPassed === b.metrics.qualityPassed ? (
                    <>Same {b.metrics.qualityPassed}/{b.metrics.qualityTotal} checks</>
                  ) : (
                    <span className={b.metrics.qualityPassed < a.metrics.qualityPassed ? 'text-cost' : 'text-signal'}>
                      Checks {a.metrics.qualityPassed}/{a.metrics.qualityTotal} → {b.metrics.qualityPassed}/{b.metrics.qualityTotal}
                    </span>
                  )}
                  {' · '}
                  <Change from={a.metrics.modelRequests} to={b.metrics.modelRequests} label="requests" />
                  {' · '}
                  <Change from={a.metrics.runtimeSeconds} to={b.metrics.runtimeSeconds} label="runtime" />
                  {tokA !== null && tokB !== null && tokA > 0 && (
                    <>
                      {' · '}
                      <Change from={tokA} to={tokB} label="tokens" />
                    </>
                  )}
                </p>
                {!extras && <p className="mt-1 font-mono text-[14.5px] text-ink-400">{experiment.comparison.note}</p>}
                <RejectedCalls a={a} b={b} />
              </div>
              {phaseRows && <PhaseTable rows={phaseRows} a={a} b={b} />}
              {experiment.comparison.review && <ReviewCard review={experiment.comparison.review} a={a} b={b} />}
            </motion.div>
          ) : (
            <motion.div
              key="sealed"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, filter: 'blur(6px)' }}
              className="flex h-[150px] items-center justify-between rounded-2xl border border-dashed border-ink-700 px-10"
            >
              <span className="text-[25px] text-ink-400">
                Verdict sealed. <span className="text-ink-200">Run the reveal to compare both recorded runs.</span>
              </span>
              <span className="flex items-center gap-2 font-mono text-[14.5px] text-ink-400">
                <Kbd>space</Kbd> run reveal
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
        </>
      )}
    </div>
  );
}

/* ---------- pieces ---------- */

function ViewTabs({ view, onView }: { view: View; onView: (v: View) => void }) {
  const tabs: { v: View; label: string }[] = [
    { v: 'full', label: 'Full runs' },
    { v: 'stage', label: 'Stage runs' },
  ];
  return (
    <div className="flex rounded-full border border-ink-700 p-1">
      {tabs.map((t) => (
        <button
          key={t.v}
          onClick={() => onView(t.v)}
          className={`rounded-full px-4 py-1.5 text-[15.5px] font-medium transition-colors ${view === t.v ? 'bg-ink-50 text-ink-950' : 'text-ink-300 hover:text-ink-100'}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Variants measured on one agent, from a saved snapshot (`wfeval stage`). Most of them have no full
 * run, so this is where they are compared, drawn like the full runs: A, then B, then the overlay.
 * It is a different measurement (one stage, a fixed starting point, 1 to 3 runs per variant), so each
 * variant is drawn as ONE real run, its middle run by requests (the lower of the two when there are
 * two), never an average, and the range over all its runs sits under the number. Two variants are
 * only called different when their runs do not overlap.
 */
interface VariantStat {
  name: string;
  runs: StageRun[];
  /** the run that is drawn */
  rep: StageRun;
}

const STAGE_GROUPS = [
  { key: 'workflow-discover', label: 'Discover' },
  { key: 'workflow-maintain', label: 'Maintain' },
  { key: 'workflow-deepen', label: 'Deepen' },
  { key: 'workflow-review', label: 'Review' },
  { key: 'workflow-deepen+workflow-review', label: 'Deepen → Review' },
];

/** The suite a snapshot belongs to, from its id (…-receipts-s1). */
const snapshotLabel = (id: string) => id.match(/-([a-z]+)-s\d+$/)?.[1] ?? id;

const rangeText = (v: number[], fmt: (n: number) => string) =>
  v.length === 0 ? '—' : Math.min(...v) === Math.max(...v) ? fmt(v[0]) : `${fmt(Math.min(...v))}–${fmt(Math.max(...v))}`;

/** The recorded values of one metric, one per run that recorded it. */
const valuesOf = (runs: StageRun[], pick: (r: StageRun) => number | null): number[] => runs.map(pick).filter((x): x is number => x !== null);

/** How B's runs sit against A's: entirely below, entirely above, or overlapping. */
function separation(a: number[], b: number[]): { kind: 'below' | 'above' | 'overlap'; gap: number } {
  if (Math.max(...b) < Math.min(...a)) return { kind: 'below', gap: Math.min(...a) - Math.max(...b) };
  if (Math.min(...b) > Math.max(...a)) return { kind: 'above', gap: Math.min(...b) - Math.max(...a) };
  return { kind: 'overlap', gap: 0 };
}

function StageRunsView() {
  const [runs, setRuns] = useState<StageRun[] | null>(null);
  const [regrades, setRegrades] = useState<StageRegrades | null>(null);
  const [variants, setVariants] = useState<VariantSummary[]>([]);
  const [group, setGroup] = useState('workflow-review');
  const [snapPick, setSnapPick] = useState('');
  const [sub, setSub] = useState<'reveal' | 'table'>('reveal');
  const [aPick, setAPick] = useState('');
  const [bPick, setBPick] = useState('');
  const [mode, setMode] = useState<Mode>('A');
  const [revealed, setRevealed] = useState(false);
  const [running, setRunning] = useState(false);
  const timers = useRef<number[]>([]);
  const clear = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => clear, []);
  useEffect(() => {
    fetchStageRuns().then(setRuns).catch(() => setRuns([]));
    fetchStageRegrades().then(setRegrades).catch(() => setRegrades(null));
    fetchVariants().then(setVariants).catch(() => setVariants([]));
  }, []);

  const inGroup = (runs ?? []).filter((r) => r.stage === group);
  const snapshots = [...new Set(inGroup.filter((r) => r.usable).map((r) => r.snapshot ?? '?'))];
  const snap = snapshots.includes(snapPick) ? snapPick : snapshots[0];
  const shown = inGroup.filter((r) => (r.snapshot ?? '?') === snap || !r.usable);
  const usable = shown.filter((r) => r.usable && (r.snapshot ?? '?') === snap);
  const names = [...new Set(usable.map((r) => r.variant ?? '?'))];
  const stats: VariantStat[] = names.map((name) => {
    const rs = usable.filter((r) => (r.variant ?? '?') === name);
    const byReq = rs.filter((r) => r.requests !== null).sort((p, q) => p.requests! - q.requests!);
    return { name, runs: rs, rep: byReq.length ? byReq[Math.floor((byReq.length - 1) / 2)] : rs[0] };
  });
  const aName = names.includes(aPick) ? aPick : names.includes('baseline') ? 'baseline' : names[0];
  const bName = names.includes(bPick) ? bPick : names.includes('clearer-rejection') && group === 'workflow-review' ? 'clearer-rejection' : names[names.length - 1];
  const A = stats.find((x) => x.name === aName);
  const B = stats.find((x) => x.name === bName);

  const metrics = [
    { key: 'requests', pick: (r: StageRun) => r.requests, fmt: (n: number) => String(n) },
    { key: 'seconds', pick: (r: StageRun) => r.seconds, fmt: (n: number) => `${n}s` },
    { key: 'output', pick: (r: StageRun) => r.outputTokens, fmt: (n: number) => fmtCount(n) ?? '—' },
  ];
  const ready = Boolean(A && B && A.name !== B.name && metrics.every((m) => m.pick(A!.rep) !== null && m.pick(B!.rep) !== null));
  const seps = ready ? metrics.map((m) => separation(valuesOf(A!.runs, m.pick), valuesOf(B!.runs, m.pick))) : [];

  const reveal = () => {
    clear();
    setRevealed(false);
    setRunning(true);
    setMode('A');
    const at = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));
    at(900, () => setMode('B'));
    at(3100, () => setMode('AB'));
    at(4300, () => {
      setRevealed(true);
      setRunning(false);
    });
  };
  usePlayKey(() => {
    if (sub === 'reveal' && ready) reveal();
  });
  const restart = () => {
    clear();
    setRunning(false);
    setRevealed(false);
    setMode('A');
  };

  const pill = (active: boolean) =>
    `rounded-full border px-4 py-1.5 font-mono text-[13.5px] uppercase tracking-[0.12em] transition-colors ${
      active ? 'border-signal/70 text-signal' : 'border-ink-700 text-ink-400 hover:border-ink-500'
    }`;
  const showDelta = mode === 'AB';
  const shownStat = mode === 'A' ? A : B;
  const chip = (va: number, vb: number, fmt: (n: number) => string) => (
    <DeltaChip tone={vb > va ? 'cost' : 'neutral'}>
      {sign(vb - va)}
      {fmt(Math.abs(vb - va))} · {signedPct(va, vb)}
    </DeltaChip>
  );
  const headline = !ready
    ? ''
    : seps.every((x) => x.kind === 'below')
      ? 'Cheaper on this stage, in every run. The full pipeline was not measured.'
      : seps.every((x) => x.kind === 'above')
        ? 'Costlier on this stage, in every run. The full pipeline was not measured.'
        : seps.some((x) => x.kind === 'overlap')
          ? 'Runs overlap on at least one measure: too few runs to call it.'
          : 'Mixed on this stage: lower on some measures, higher on others.';
  const checksOf = (st: VariantStat) => st.runs.map((r) => checksText(r, regrades) ?? '—').join(' · ');
  const failedOf = (st: VariantStat) => st.runs.map((r) => (r.failedCalls === null ? '—' : String(r.failedCalls))).join(' · ');
  const options = names.map((n) => ({ value: n, label: n }));
  const groupLabel = STAGE_GROUPS.find((g) => g.key === group)?.label ?? '';
  const have = (key: string) => (runs ?? []).some((r) => r.stage === key && r.usable);

  return (
    <div className="mt-6 flex min-h-0 flex-1 flex-col pb-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {STAGE_GROUPS.map((g) => (
          <button
            key={g.key}
            onClick={() => { setGroup(g.key); setSnapPick(''); setAPick(''); setBPick(''); restart(); }}
            className={`${pill(group === g.key)} ${have(g.key) || group === g.key ? '' : 'opacity-50'}`}
          >
            {g.label}
          </button>
        ))}
        <span className="mx-2 h-5 border-l border-ink-700" />
        <button onClick={() => setSub('reveal')} className={pill(sub === 'reveal')}>Reveal</button>
        <button onClick={() => setSub('table')} className={pill(sub === 'table')}>All variants</button>
        {snapshots.length > 1 && (
          <>
            <span className="mx-2 h-5 border-l border-ink-700" />
            {snapshots.map((sn) => (
              <button key={sn} onClick={() => { setSnapPick(sn); setAPick(''); setBPick(''); restart(); }} className={pill(snap === sn)} title={sn}>
                {snapshotLabel(sn)}
              </button>
            ))}
          </>
        )}
      </div>

      {runs === null ? (
        <p className="font-mono text-[15.5px] text-ink-400">loading stage runs…</p>
      ) : usable.length === 0 ? (
        <p className="text-[17.5px] text-ink-400">
          No recorded {groupLabel} stage runs. They are read from <code className="font-mono">eval/runs/</code> on the machine running the pipeops server.
        </p>
      ) : sub === 'table' ? (
        <StageRunsTable runs={shown} variants={variants} regrades={regrades} title={groupLabel} />
      ) : (
        <>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[13px] uppercase tracking-widest text-ink-400">A</span>
            <div className="w-[240px]"><Select value={aName} onChange={(v) => { setAPick(v); restart(); }} options={options} /></div>
            <span className="font-mono text-[13px] uppercase tracking-widest text-ink-400">B</span>
            <div className="w-[240px]"><Select value={bName} onChange={(v) => { setBPick(v); restart(); }} options={options} /></div>
            <div className="flex-1" />
            {ready && (
              <>
                <ModeSwitch mode={mode} a={{ label: aName }} b={{ label: bName }} onMode={(m) => { clear(); setRunning(false); setMode(m); if (m === 'AB') setRevealed(true); }} />
                <PrimaryButton size="lg" onClick={reveal}>
                  <PlayIcon /> {running ? 'Running reveal…' : revealed ? 'Replay reveal' : 'Run reveal'}
                </PrimaryButton>
              </>
            )}
          </div>

          {!ready ? (
            <p className="mt-8 text-[17.5px] text-ink-400">
              {A && B && A.name !== B.name
                ? 'One of these variants did not record requests, time or output tokens, so it cannot be drawn. It is in "All variants".'
                : 'Pick two different variants.'}
            </p>
          ) : (
            <>
              <div className="mt-5 flex flex-col border-t border-ink-800">
                <Lane
                  label="Model requests"
                  sub="middle run · 1 tick = 1 request"
                  viz={<RequestsViz ra={A!.rep.requests!} rb={B!.rep.requests!} mode={mode} />}
                  value={<CountUp value={shownStat!.rep.requests!} duration={1.4} />}
                  valueSub={`range ${rangeText(valuesOf(shownStat!.runs, metrics[0].pick), metrics[0].fmt)} · n=${shownStat!.runs.length}`}
                  delta={showDelta ? chip(A!.rep.requests!, B!.rep.requests!, metrics[0].fmt) : null}
                  tone={mode !== 'A' && B!.rep.requests! > A!.rep.requests! ? 'cost' : undefined}
                />
                <Lane
                  label="Agent time"
                  sub="middle run · seconds"
                  viz={<RuntimeViz sa={A!.rep.seconds!} sb={B!.rep.seconds!} mode={mode} />}
                  value={<CountUp value={shownStat!.rep.seconds!} duration={1.6} format={(n) => `${Math.round(n)}s`} />}
                  valueSub={`range ${rangeText(valuesOf(shownStat!.runs, metrics[1].pick), metrics[1].fmt)}`}
                  delta={showDelta ? chip(A!.rep.seconds!, B!.rep.seconds!, metrics[1].fmt) : null}
                  tone={mode !== 'A' && B!.rep.seconds! > A!.rep.seconds! ? 'cost' : undefined}
                />
                <Lane
                  label="Output tokens"
                  sub="middle run"
                  viz={<DeltaBar va={A!.rep.outputTokens!} vb={B!.rep.outputTokens!} mode={mode} />}
                  value={<CountUp value={shownStat!.rep.outputTokens!} duration={1.6} format={(n) => fmtCount(Math.round(n)) ?? '—'} />}
                  valueSub={`range ${rangeText(valuesOf(shownStat!.runs, metrics[2].pick), metrics[2].fmt)}`}
                  delta={showDelta ? chip(A!.rep.outputTokens!, B!.rep.outputTokens!, metrics[2].fmt) : null}
                  tone={mode !== 'A' && B!.rep.outputTokens! > A!.rep.outputTokens! ? 'cost' : undefined}
                />
              </div>

              <div className="relative mt-5 flex-1">
                <AnimatePresence mode="wait">
                  {revealed ? (
                    <motion.div
                      key="verdict"
                      initial={{ opacity: 0, y: 24, filter: 'blur(10px)' }}
                      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.9, ease: EASE }}
                      className="flex items-start gap-10"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-3">
                          <Eyebrow size="lg" className="text-signal">Conclusion</Eyebrow>
                          <span className="rounded-full border border-ink-700 px-2.5 py-0.5 font-mono text-[12px] uppercase tracking-widest text-ink-400">
                            stage runs · {B!.runs.length} vs {A!.runs.length} runs
                          </span>
                        </div>
                        <div className="mt-2 text-[40px] font-semibold leading-[1.05] tracking-tightest text-ink-50">{headline}</div>
                        <p className="mt-3 text-[17.5px] leading-snug text-ink-300">
                          {bName} vs {aName}:{' '}
                          {metrics.map((m, i) => (
                            <span key={m.key}>
                              {i > 0 && ' · '}
                              <span className={seps[i].kind === 'above' ? 'text-cost' : seps[i].kind === 'below' ? 'text-signal' : ''}>
                                {['requests', 'agent time', 'output tokens'][i]} {rangeText(valuesOf(B!.runs, m.pick), m.fmt)} vs {rangeText(valuesOf(A!.runs, m.pick), m.fmt)}
                              </span>
                            </span>
                          ))}
                        </p>
                      </div>
                      <div className="w-[560px] shrink-0 rounded-xl border border-ink-700 p-3.5 font-mono text-[14.5px] leading-relaxed text-ink-300">
                        <div className="text-[12.5px] uppercase tracking-widest text-ink-400">One value per run</div>
                        <div className="mt-1.5"><span className="text-ink-400">checks </span>{aName}: {checksOf(A!)}</div>
                        <div className="pl-[52px]">{bName}: {checksOf(B!)}</div>
                        <div className="mt-1.5"><span className="text-ink-400">failed calls </span>{aName}: {failedOf(A!)}</div>
                        <div className="pl-[96px]">{bName}: {failedOf(B!)}</div>
                        <div className="mt-2 font-sans text-[13.5px] leading-snug text-ink-400">
                          Drawn: each variant's middle run, not an average. — = not recorded. Different only where the runs do not overlap. Not comparable to full-run scores.
                        </div>
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="sealed"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0, filter: 'blur(6px)' }}
                      className="flex h-[110px] items-center justify-between rounded-2xl border border-dashed border-ink-700 px-10"
                    >
                      <span className="text-[23px] text-ink-400">
                        Verdict sealed. <span className="text-ink-200">Run the reveal to compare both variants on this stage.</span>
                      </span>
                      <span className="flex items-center gap-2 font-mono text-[14.5px] text-ink-400">
                        <Kbd>space</Kbd> run reveal
                      </span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** A plain two-value bar with the same A, B, overlay behaviour as the runtime bar, without a time axis. */
function DeltaBar({ va, vb, mode }: { va: number; vb: number; mode: Mode }) {
  const width = VIZ_W;
  const max = Math.max(va, vb);
  const x = (v: number) => (v / max) * width;
  const aX = x(va);
  const bX = x(vb);
  const loX = Math.min(aX, bX);
  const hiX = Math.max(aX, bX);
  const grew = vb >= va;
  const hideDelta = mode === 'A' || (mode === 'B' && !grew);
  return (
    <div className="relative" style={{ width, height: 72 }}>
      <div className="absolute top-[26px] h-[20px] w-full rounded-full bg-ink-850" />
      <motion.div
        className="absolute top-[26px] h-[20px] rounded-l-full bg-ink-200"
        initial={false}
        animate={{ width: mode === 'A' ? aX : loX, borderTopRightRadius: hideDelta ? 999 : 0, borderBottomRightRadius: hideDelta ? 999 : 0 }}
        transition={{ duration: 1.2, ease: EASE }}
      />
      <motion.div
        className={`absolute top-[26px] h-[20px] rounded-r-full ${grew ? 'bg-cost' : 'bg-signal'}`}
        style={{ left: loX }}
        initial={false}
        animate={{ width: hideDelta ? 0 : hiX - loX, opacity: hideDelta ? 0 : 1 }}
        transition={{ duration: 1.8, ease: EASE }}
      />
      <div className="absolute top-[16px] h-[40px] border-l border-dashed border-ink-400" style={{ left: loX }} />
    </div>
  );
}


function ModeSwitch({ mode, a, b, onMode }: { mode: Mode; a: { label: string }; b: { label: string }; onMode: (m: Mode) => void }) {
  const opts: { m: Mode; label: string }[] = [
    { m: 'A', label: a.label },
    { m: 'B', label: b.label },
    { m: 'AB', label: 'Overlay Δ' },
  ];
  return (
    <div className="relative flex rounded-full border border-ink-700 bg-ink-900/80 p-1">
      {opts.map((o) => (
        <button
          key={o.m}
          onClick={() => onMode(o.m)}
          className={`relative z-10 rounded-full px-4 py-1.5 text-[15.5px] font-medium transition-colors ${
            mode === o.m ? 'text-ink-950' : 'text-ink-300 hover:text-ink-100'
          }`}
        >
          {mode === o.m && (
            <motion.span
              layoutId="cmp-pill"
              className="absolute inset-0 -z-10 rounded-full bg-ink-50"
              transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            />
          )}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Lane({
  label,
  sub,
  viz,
  value,
  valueSub,
  delta,
  tone,
  height = 124,
}: {
  label: string;
  sub: string;
  viz: ReactNode;
  value: ReactNode;
  valueSub?: string;
  delta: ReactNode;
  tone?: 'cost';
  /** px; the token row has two lines of figures */
  height?: number;
}) {
  return (
    <div className="flex items-center border-b border-ink-800" style={{ height }}>
      <div className="w-[230px] shrink-0">
        <div className="text-[25px] font-medium text-ink-50">{label}</div>
        <div className="mt-1 font-mono text-[15.5px] text-ink-400">{sub}</div>
      </div>
      <div className="flex-1">{viz}</div>
      <div className="flex w-[360px] shrink-0 flex-col items-end">
        <div
          className={`text-[84px] font-semibold leading-none tracking-tightest transition-colors duration-700 ${
            tone === 'cost' ? 'text-cost' : 'text-ink-50'
          }`}
        >
          {value}
        </div>
        <div className="mt-1.5 flex h-8 items-center gap-3">
          {valueSub && <span className="whitespace-nowrap font-mono text-[14.5px] text-ink-400">{valueSub}</span>}
          <AnimatePresence>{delta}</AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/** Workflows calls the engine refused (usage.workspace.failed), each one a retry for the agent.
 *  Shown only when at least one run logged it; "not logged" is not zero. */
function RejectedCalls({ a, b }: { a: Run; b: Run }) {
  const av = a.metrics.failedCalls ?? null;
  const bv = b.metrics.failedCalls ?? null;
  if (av === null && bv === null) return null;
  const side = (label: string, v: number | null) => (
    <span>
      <span className="text-ink-400">{label} </span>
      {v === null ? <span className="text-ink-400">not logged</span> : <span className="tnum text-ink-100">{v}</span>}
    </span>
  );
  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[15.5px]"
      title="Workflows calls the engine refused (usage.workspace.failed); each one costs the agent a retry"
    >
      <span className="text-[13px] uppercase tracking-widest text-ink-400">Rejected calls</span>
      {side(a.label, av)}
      <span className="text-ink-500">→</span>
      {side(b.label, bv)}
      {av !== null && bv !== null && av !== bv && av > 0 && (
        <span className={bv > av ? 'text-cost' : 'text-signal'}>{signedPct(av, bv)}</span>
      )}
    </div>
  );
}

/** "requests −48.0%": the direction decides the colour, so a saving is never drawn as a cost. */
function Change({ from, to, label }: { from: number; to: number; label: string }) {
  if (from === 0) return <span>{label} {from} → {to}</span>;
  return (
    <span className={to > from ? 'text-cost' : 'text-signal'}>
      {sign(to - from)}
      {Math.abs(Math.round(pct(from, to)))}% {label}
    </span>
  );
}

/** Both runs' phases side by side, only when each has the same phases recorded. */
function pairPhases(a: Run, b: Run): { a: PhaseResult; b: PhaseResult }[] | null {
  // One phase says nothing the totals above do not: a breakdown needs at least two.
  if (!a.phases || !b.phases || a.phases.length < 2 || a.phases.length !== b.phases.length) return null;
  const rows = a.phases.map((p, i) => ({ a: p, b: b.phases![i] }));
  return rows.every((r) => r.a.phase === r.b.phase) ? rows : null;
}

const cellOf = (p: PhaseResult) =>
  p.requests === null ? (
    <span className="text-ink-500" title="not recorded">—</span>
  ) : (
    <span className="tnum">
      {p.requests} <span className="text-ink-400">req</span>
      {p.runtimeSeconds !== null && <span className="text-ink-400"> · {p.runtimeSeconds}s</span>}
    </span>
  );

/** What each phase cost. A phase where one run opened no cycle because nothing new was recorded is called out. */
function PhaseTable({ rows, a, b }: { rows: { a: PhaseResult; b: PhaseResult }[]; a: Run; b: Run }) {
  return (
    <div className="w-[560px] shrink-0">
      <Eyebrow>By phase</Eyebrow>
      <table className="mt-2 w-full border-collapse text-left font-mono text-[15.5px]">
        <thead>
          <tr className="text-[12.5px] uppercase tracking-widest text-ink-400">
            <th className="w-[70px] py-1 font-normal">Phase</th>
            <th className="font-normal">{a.label}</th>
            <th className="font-normal">{b.label}</th>
            <th className="text-right font-normal">Requests</th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap(({ a: pa, b: pb }) => {
            const idleRun = pa.cycleStatus === 'idle' ? a : pb.cycleStatus === 'idle' ? b : null;
            const quiet = pa.frames === 0 && idleRun !== null;
            const churn = pa.mistakes?.idle_churn ?? pb.mistakes?.idle_churn ?? 0;
            const tint = quiet ? 'bg-signal/[0.07]' : '';
            const cell = (p: PhaseResult) => (p.cycleStatus === 'idle' ? 'no cycle started' : cellOf(p));
            const out = [
              <tr key={pa.phase} className={tint}>
                <td className="border-t border-ink-800 py-1.5 pl-1 text-ink-300">{pa.phase}</td>
                <td className="border-t border-ink-800 text-ink-200">{cell(pa)}</td>
                <td className="border-t border-ink-800 text-ink-200">{cell(pb)}</td>
                <td className="border-t border-ink-800 text-right">
                  {pa.requests !== null && pb.requests !== null && pa.requests !== pb.requests ? (
                    <span className={pb.requests > pa.requests ? 'text-cost' : 'text-signal'}>
                      {pa.requests} → {pb.requests}
                    </span>
                  ) : (
                    <span className="text-ink-400">{pa.requests ?? '—'}</span>
                  )}
                </td>
              </tr>,
            ];
            if (quiet) {
              out.push(
                <tr key={`${pa.phase}-note`} className={tint}>
                  <td />
                  <td colSpan={3} className="pb-1.5 font-sans text-[14.5px] leading-snug text-ink-300">
                    Nothing new was recorded. {idleRun.label} ran no cycle
                    {churn > 0 ? `; ${idleRun === a ? b.label : a.label} rewrote a workflow anyway` : ''}.
                  </td>
                </tr>,
              );
            }
            return out;
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A separate, non-automatic review of the same pair. Never merged into the checks above. */
function ReviewCard({ review, a, b }: { review: PairReview; a: Run; b: Run }) {
  const n = review.pairs.length;
  const { baseline, variant, inconsistent } = review.summary;
  const winner = baseline > variant ? { run: a, wins: baseline } : variant > baseline ? { run: b, wins: variant } : null;
  return (
    <div className="w-[360px] shrink-0 rounded-xl border border-ink-700 p-3.5" title={`${review.method.note} Source: ${review.method.describedIn}`}>
      <div className="flex items-center justify-between">
        <Eyebrow>LLM judge</Eyebrow>
        <span className="rounded-full border border-ink-600 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-400">not an automatic check</span>
      </div>
      <p className="mt-2 text-[17.5px] font-medium leading-snug text-ink-100">
        {winner ? (
          <>
            {winner.run.label}'s documents preferred in {winner.wins} of {n} pairs.
          </>
        ) : (
          <>No clear preference ({inconsistent} of {n} pairs disagree).</>
        )}
      </p>
      <p className="mt-1.5 text-[14.5px] leading-snug text-ink-400">{review.judgments} judgments. The same model wrote and judged the documents.</p>
    </div>
  );
}

const TOKEN_COLS: { label: string; get: (e: Efficiency) => number | null }[] = [
  { label: 'Input', get: (e) => e.input },
  { label: 'Cache read', get: (e) => e.cacheRead },
  { label: 'Cache write', get: (e) => e.cacheWrite },
  { label: 'Output', get: (e) => e.output },
];

/**
 * One row per run. A null cell is "not recorded" (an em dash), a recorded zero is "0" —
 * the two are never mixed. Cache reads and writes are separate columns, not folded into
 * Input, so nothing is counted twice; the total above is the sum of the four columns.
 */
function TokensViz({ a, b, mode }: { a: Run; b: Run; mode: Mode }) {
  const rows: { tag: string; run: Run }[] = mode === 'AB' ? [{ tag: 'A', run: a }, { tag: 'B', run: b }] : [{ tag: mode, run: mode === 'A' ? a : b }];
  const cell = (n: number | null, base?: number | null) => (
    <div className="flex flex-col">
      <span className={`tnum font-mono text-[21px] ${n === null ? 'text-ink-400' : 'text-ink-100'}`} title={n === null ? 'not recorded' : n.toLocaleString('en-US')}>
        {fmtCount(n) ?? '—'}
      </span>
      {base != null && n !== null && base > 0 && (
        <span className={`tnum font-mono text-[13px] ${n > base ? 'text-cost' : 'text-ink-400'}`}>
          {n >= base ? '+' : '−'}
          {Math.abs(pct(base, n)).toFixed(0)}%
        </span>
      )}
    </div>
  );
  const note = (e: Efficiency | null | undefined) =>
    !e ? 'no usage recorded' : e.source === 'pipe_logs' ? 'partial: pipe logs undercount' : e.source === null ? 'source not recorded' : null;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-end gap-4 pl-7 font-mono text-[14.5px] uppercase tracking-widest text-ink-400">
        {TOKEN_COLS.map((c) => (
          <span key={c.label} className="w-[150px]" title={c.label === 'Input' ? 'Uncached input only: cache reads and writes are separate columns' : undefined}>
            {c.label}
          </span>
        ))}
        <span className="w-[110px]">Cache hit</span>
      </div>
      {rows.map(({ tag, run }) => {
        const e = run.efficiency;
        const base = mode === 'AB' && tag === 'B' ? a.efficiency : null;
        const hit = cacheHitRate(e);
        const baseHit = base ? cacheHitRate(base) : null;
        return (
          <div key={tag} className="flex items-center gap-4">
            <span className="w-3 font-mono text-[15.5px] text-ink-400">{tag}</span>
            {TOKEN_COLS.map((c) => (
              <div key={c.label} className="w-[150px]">{cell(e ? c.get(e) : null, base ? c.get(base) : null)}</div>
            ))}
            <div className="w-[110px]">
              <span className={`tnum font-mono text-[21px] ${hit === null ? 'text-ink-400' : 'text-ink-100'}`}>
                {hit === null ? '—' : `${(hit * 100).toFixed(1)}%`}
              </span>
              {baseHit !== null && hit !== null && (
                <div className="tnum font-mono text-[15.5px] text-ink-400">{((hit - baseHit) * 100).toFixed(1)} pts</div>
              )}
            </div>
            {note(e) && <span className="font-mono text-[15.5px] text-cost">{note(e)}</span>}
          </div>
        );
      })}
    </div>
  );
}

function DeltaChip({ children, tone }: { children: ReactNode; tone: 'cost' | 'neutral' }) {
  return (
    <motion.span
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className={`tnum whitespace-nowrap rounded-full px-3 py-0.5 font-mono text-[16px] font-medium ${
        tone === 'cost' ? 'bg-cost/20 text-cost' : 'bg-signal/20 text-signal'
      }`}
    >
      {children}
    </motion.span>
  );
}

/** Quality never moves between runs: the blocks stay put, only the stamp changes. */
function QualityViz({ a, b, mode }: { a: Run; b: Run; mode: Mode }) {
  const total = Math.max(a.metrics.qualityTotal, b.metrics.qualityTotal);
  const same = a.metrics.qualityPassed === b.metrics.qualityPassed && a.metrics.qualityTotal === b.metrics.qualityTotal;
  const row = (run: Run, small = false) => (
    <div className="flex gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`${small ? 'h-[10px]' : 'h-[34px]'} ${total > 11 ? 'w-[56px]' : 'w-[72px]'} rounded-[6px] ${
            i < run.metrics.qualityPassed ? 'bg-signal' : 'border border-dashed border-ink-600'
          }`}
        />
      ))}
    </div>
  );
  return (
    <div className="flex items-center gap-8">
      <div className="flex flex-col gap-2">
        {mode === 'AB' ? (
          <>
            <div className="flex items-center gap-3">
              <span className="w-4 font-mono text-[15.5px] text-ink-400">A</span>
              {row(a, true)}
            </div>
            <div className="flex items-center gap-3">
              <span className="w-4 font-mono text-[15.5px] text-ink-400">B</span>
              {row(b, true)}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-3">
            <span className="w-4 font-mono text-[15.5px] text-ink-400">{mode}</span>
            {row(mode === 'A' ? a : b)}
          </div>
        )}
      </div>
      <AnimatePresence>
        {mode !== 'A' && same && (
          <motion.span
            initial={{ opacity: 0, scale: 1.4, rotate: -8 }}
            animate={{ opacity: 1, scale: 1, rotate: -4 }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 16 }}
            className="rounded-md border-2 border-signal px-3 py-1 font-mono text-[16.5px] font-semibold uppercase tracking-[0.2em] text-signal"
          >
            unchanged
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

function RequestsViz({ ra, rb, mode }: { ra: number; rb: number; mode: Mode }) {
  const pal = ANIMATED[useTheme()];
  const max = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  const grew = rb >= ra; // the ticks between lo and max are extra cost when B grew, a saving when B shrank
  const width = VIZ_W;
  const pitch = width / max;
  const shownCount = mode === 'A' ? ra : mode === 'B' ? rb : max;
  const loX = lo * pitch;
  return (
    <div className="relative" style={{ width, height: 72 }}>
      <svg width={width} height={72} className="overflow-visible">
        {Array.from({ length: max }, (_, i) => {
          const visible = i < shownCount;
          const delta = i >= lo;
          return (
            <motion.rect
              key={i}
              x={i * pitch}
              width={Math.max(2, pitch - 3.5)}
              rx={1}
              initial={false}
              animate={{
                y: visible ? 12 : 44,
                height: visible ? 48 : 16,
                fill: !visible ? pal.off : delta && mode !== 'A' ? (grew ? pal.cost : pal.signal) : pal.on,
              }}
              transition={{ delay: delta ? (i - lo) * 0.035 : 0, duration: 0.35, ease: 'easeOut' }}
            />
          );
        })}
        {/* the shorter run's boundary */}
        <line x1={loX - 1.5} x2={loX - 1.5} y1={0} y2={72} stroke="rgb(var(--ink-400))" strokeDasharray="3 3" />
      </svg>
      <span className="absolute -bottom-5 font-mono text-[12px] text-ink-400" style={{ left: loX - 60 }}>
        {grew ? 'A' : 'B'} ends · {lo}
      </span>
      <AnimatePresence>
        {mode === 'AB' && ra !== rb && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute -top-6 flex items-center"
            style={{ left: loX, width: (max - lo) * pitch }}
          >
            <div className={`h-2 flex-1 border-x border-t ${grew ? 'border-cost/70' : 'border-signal/70'}`} />
            <span className={`px-2 font-mono text-[13px] ${grew ? 'text-cost' : 'text-signal'}`}>
              {sign(rb - ra)}
              {Math.abs(rb - ra)}
            </span>
            <div className={`h-2 flex-1 border-x border-t ${grew ? 'border-cost/70' : 'border-signal/70'}`} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function RuntimeViz({ sa, sb, mode }: { sa: number; sb: number; mode: Mode }) {
  const width = VIZ_W;
  const maxSec = Math.ceil(Math.max(sa, sb) / 300) * 300; // round to 5 min
  const x = (sec: number) => (sec / maxSec) * width;
  const aX = x(sa);
  const bX = x(sb);
  const loX = Math.min(aX, bX);
  const hiX = Math.max(aX, bX);
  const grew = sb >= sa; // the stretch between the two ends is extra time when B grew, time saved when it shrank
  const ticks = Array.from({ length: maxSec / 300 + 1 }, (_, i) => i * 300);
  const roundRight = mode === 'A' || (mode === 'B' && !grew);
  return (
    <div className="relative" style={{ width, height: 72 }}>
      {/* grid */}
      {ticks.map((t) => (
        <div key={t} className="absolute top-0 h-[52px] border-l border-ink-800" style={{ left: x(t) }}>
          <span className="absolute -left-2 top-[56px] font-mono text-[14.5px] text-ink-400">{t / 60}m</span>
        </div>
      ))}
      {/* track */}
      <div className="absolute top-[18px] h-[20px] w-full rounded-full bg-ink-850" />
      {/* the part both runs share */}
      <motion.div
        className="absolute top-[18px] h-[20px] rounded-l-full bg-ink-200"
        initial={false}
        animate={{ width: mode === 'A' ? aX : loX, borderTopRightRadius: roundRight ? 999 : 0, borderBottomRightRadius: roundRight ? 999 : 0 }}
        transition={{ duration: 1.2, ease: EASE }}
      />
      {/* the difference: extra time (cost) or time saved */}
      <motion.div
        className={`absolute top-[18px] h-[20px] rounded-r-full ${
          grew ? 'bg-cost shadow-[0_0_24px_-2px_rgb(var(--cost)/0.55)]' : 'bg-signal shadow-[0_0_24px_-2px_rgb(var(--signal)/0.45)]'
        }`}
        style={{ left: loX }}
        initial={false}
        animate={{ width: mode === 'A' || (mode === 'B' && !grew) ? 0 : hiX - loX, opacity: mode === 'A' || (mode === 'B' && !grew) ? 0 : 1 }}
        transition={{ duration: 1.8, ease: EASE }}
      />
      <div className="absolute top-[8px] h-[40px] border-l border-dashed border-ink-400" style={{ left: loX }} />
      <AnimatePresence>
        {mode === 'AB' && sa !== sb && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute -top-5 flex items-center"
            style={{ left: loX, width: hiX - loX }}
          >
            <div className={`h-2 flex-1 border-x border-t ${grew ? 'border-cost/70' : 'border-signal/70'}`} />
            <span className={`px-2 font-mono text-[13px] ${grew ? 'text-cost' : 'text-signal'}`}>
              {sign(sb - sa)}
              {Math.abs(sb - sa)}s
            </span>
            <div className={`h-2 flex-1 border-x border-t ${grew ? 'border-cost/70' : 'border-signal/70'}`} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
