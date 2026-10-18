import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import type { Experiment, Run, WorkflowRecord } from '../data/schema';
import { CheckRing } from '../components/CheckRing';
import { Badge, Eyebrow, Missing, PlayIcon, PrimaryButton } from '../components/ui';
import { pad2 } from '../lib/format';
import { usePlayKey } from '../lib/events';

export function EvidenceView({ experiment, run }: { experiment: Experiment; run: Run }) {
  if (!run.checksLoaded) return <NoCheckDetail run={run} />;
  return <LoadedEvidenceView experiment={experiment} run={run} />;
}

/** Honest fallback: the artifact gave us a pass/total, nothing per-check. Say exactly that —
 *  no synthesized "Unnamed check" slots, no invented evidence. */
function NoCheckDetail({ run }: { run: Run }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-10">
      <Eyebrow size="lg">Evidence explorer</Eyebrow>
      <div className="mt-4 text-[68px] font-semibold leading-none tracking-tightest text-ink-50">
        {run.metrics.qualityPassed}/{run.metrics.qualityTotal}
        <span className="ml-3 text-[32px] font-normal text-ink-400">checks passed</span>
      </div>
      <p className="mt-6 max-w-[520px] text-center text-[17.5px] leading-relaxed text-ink-400">
        Individual check details are unavailable in this artifact.
      </p>
      <div className="mt-4">
        <Missing path="runs[].checks" />
      </div>
    </div>
  );
}

function LoadedEvidenceView({ experiment, run }: { experiment: Experiment; run: Run }) {
  const [selected, setSelected] = useState(0);
  const [lens, setLens] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const scanTimer = useRef<number | null>(null);
  const n = run.checks.length;

  const scan = () => {
    if (scanTimer.current) window.clearInterval(scanTimer.current);
    setScanning(true);
    let i = 0;
    setSelected(0);
    scanTimer.current = window.setInterval(() => {
      i += 1;
      if (i >= n) {
        window.clearInterval(scanTimer.current!);
        scanTimer.current = null;
        setScanning(false);
        setSelected(0);
        return;
      }
      setSelected(i);
    }, 170);
  };
  useEffect(() => () => {
    if (scanTimer.current) window.clearInterval(scanTimer.current);
  }, []);
  usePlayKey(scan);

  const check = run.checks[selected];
  const passedCount = run.checks.filter((c) => c.passed).length;
  const lensCount = (id: string) => run.checks.filter((c) => c.lens === id).length;
  const lensesMapped = run.checks.some((c) => c.lens !== null);
  const inLens = (i: number) => lens === null || run.checks[i].lens === lens;

  return (
    <div className="flex h-full">
      {/* -------- lenses -------- */}
      <aside className="flex w-[400px] shrink-0 flex-col border-r border-ink-800 px-10 py-8">
        <Eyebrow size="lg" className="!text-signal">Evidence explorer</Eyebrow>
        <h2 className="mt-3 text-[44px] font-semibold leading-[1.02] tracking-tightest text-ink-50">
          Why did each check pass?
        </h2>

        <div className="mt-12 flex flex-col gap-3">
          <LensRow label="All checks" count={n} active={lens === null} onClick={() => setLens(null)} />
          {experiment.evidenceLenses.map((l) => (
            <LensRow
              key={l.id}
              label={l.label}
              count={lensesMapped ? lensCount(l.id) : null}
              active={lens === l.id}
              onClick={() => setLens(l.id)}
            />
          ))}
        </div>
        {!lensesMapped && (
          <div className="mt-4">
            <Missing size="sm" path="checks[].lens" />
            <p className="mt-2 text-[14.5px] leading-relaxed text-ink-400">
              The artifact does not say which lens each check belongs to, so lens filters show no checks yet.
            </p>
          </div>
        )}

        <PrimaryButton size="xl" className="mt-auto self-start" onClick={scan}>
          <PlayIcon /> {scanning ? 'Scanning checks…' : 'Scan all checks'}
        </PrimaryButton>
      </aside>

      {/* -------- instrument -------- */}
      <section className="relative flex flex-1 flex-col items-center px-10 pt-14">
        <div className="relative">
          <CheckRing
            passed={run.checks.map((c) => c.passed)}
            dimmed={run.checks.map((_, i) => !inLens(i))}
            size={430}
            stroke={22}
            gapDeg={4}
            selected={selected}
            onSelect={setSelected}
            showIndex
          />
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <AnimatePresence mode="popLayout">
              <motion.div
                key={selected}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18 }}
                className="flex flex-col items-center"
              >
                <span className="font-mono text-[16px] uppercase tracking-[0.2em] text-ink-400">check {pad2(selected + 1)}</span>
                <span className={`mt-1 text-[100px] font-semibold leading-none tracking-tightest ${check.passed ? 'text-signal text-glow' : 'text-cost'}`}>
                  {check.passed ? 'PASS' : 'FAIL'}
                </span>
              </motion.div>
            </AnimatePresence>
            <span className="tnum mt-3 font-mono text-[18px] text-ink-300">
              {passedCount}/{n} passed
            </span>
          </div>
          {lens !== null && (
            <div className="absolute inset-x-0 -bottom-9 text-center font-mono text-[13px] text-ink-400">
              {lensesMapped ? `${lensCount(lens)} checks in this lens` : '0 checks mapped to this lens · lens not in artifact'}
            </div>
          )}
        </div>

        {/* centred in the space below the ring */}
        <div className="flex w-full flex-1 items-center justify-center pb-6">
          <Matching run={run} />
        </div>
      </section>

      {/* -------- dossier -------- */}
      <aside className="w-[520px] shrink-0 border-l border-ink-800 bg-ink-950/70">
        <AnimatePresence mode="wait">
          <motion.div
            key={`${run.id}-${selected}`}
            initial={{ opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.2 }}
            className="flex h-full flex-col overflow-y-auto px-10 py-8"
          >
            <div className="flex items-center justify-between">
              <Eyebrow size="lg">Dossier · check {pad2(selected + 1)} of {pad2(n)}</Eyebrow>
              <div className="flex gap-1">
                <NavBtn onClick={() => setSelected((selected - 1 + n) % n)}>‹</NavBtn>
                <NavBtn onClick={() => setSelected((selected + 1) % n)}>›</NavBtn>
              </div>
            </div>

            <div className="mt-4">
              {check.name ? (
                <div className="text-[32px] font-semibold tracking-tight text-ink-50">{check.name}</div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="text-[32px] font-semibold tracking-tight text-ink-400">Unnamed check</div>
                  <Missing size="sm" path={`checks[${selected}].name`} />
                </div>
              )}
            </div>

            {/* verdict + provenance */}
            <div className={`mt-6 rounded-2xl border p-5 ${check.passed ? 'border-signal/40 bg-signal/[0.05]' : 'border-cost/40 bg-cost/[0.06]'}`}>
              <div className="flex items-center justify-between">
                <span className={`flex items-center gap-3 text-[25px] font-semibold ${check.passed ? 'text-signal' : 'text-cost'}`}>
                  <span className={`flex h-8 w-8 items-center justify-center rounded-full ${check.passed ? 'bg-signal text-on-signal' : 'bg-cost text-on-signal'}`}>
                    {check.passed ? '✓' : '×'}
                  </span>
                  {check.passed ? 'Passed' : 'Failed'}
                </span>
              </div>
              {/* in_stages: reported by the grader for passing keyword checks, never scored */}
              {check.passed && check.inStages != null && (
                <p
                  className={`mt-2 flex items-start gap-2 text-[15.5px] leading-relaxed ${check.inStages ? 'text-ink-300' : 'text-cost'}`}
                  title="Reported by the grader (in_stages), not scored"
                >
                  <span className="mt-[3px] font-mono text-[12px] uppercase tracking-widest text-ink-400">in steps</span>
                  {check.inStages
                    ? 'Its words are in the workflow’s steps: the workflow says what to do.'
                    : 'Passes on wording only: the words appear in a variation, question or limitation, not in the steps.'}
                </p>
              )}
            </div>

            {/* why: only when the grader recorded a reason */}
            {check.reason && (
              <div className="mt-6">
                <Eyebrow size="lg">Why</Eyebrow>
                <p className="mt-2 text-[17.5px] leading-relaxed text-ink-100">{check.reason}</p>
              </div>
            )}

            {/* expected vs actual */}
            <div className="mt-6 grid grid-cols-2 gap-3">
              <Side label="Expected" value={check.expected} path={`checks[${selected}].expected`} />
              <Side label="Actual" value={check.actual} path={`checks[${selected}].actual`} />
            </div>

            {/* evidence */}
            <div className="mt-6">
              <Eyebrow size="lg">Evidence</Eyebrow>
              <div className="mt-2 space-y-2">
                {check.evidence ? (
                  check.evidence.map((e, k) => (
                    <div key={k} className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-[14px] text-ink-200 [overflow-wrap:anywhere]">
                      {e}
                    </div>
                  ))
                ) : (
                  <Missing path={`checks[${selected}].evidence`} />
                )}
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </aside>
    </div>
  );
}

function LensRow({ label, count, active, onClick }: { label: string; count: number | null; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center justify-between rounded-xl px-4 py-4 text-left transition ${
        active ? 'bg-signal/[0.08] text-signal ring-1 ring-signal/50' : 'text-signal/70 hover:bg-ink-900 hover:text-signal'
      }`}
    >
      <span className="flex items-center gap-3 text-[19px]">
        <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-signal' : 'bg-signal/40'}`} />
        {label}
      </span>
      <span className="tnum font-mono text-[18px] text-current">{count ?? '—'}</span>
    </button>
  );
}

function NavBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-full border border-ink-700 text-[21px] text-ink-300 hover:border-ink-400 hover:text-ink-50"
    >
      {children}
    </button>
  );
}

function Side({ label, value, path }: { label: string; value: string | null; path: string }) {
  return (
    <div className={`min-h-[96px] rounded-xl border p-3 ${value ? 'border-ink-700 bg-ink-900' : 'hatch-muted border-dashed border-ink-700'}`}>
      <div className="font-mono text-[13px] uppercase tracking-widest text-ink-400">{label}</div>
      <div className="mt-2 max-h-[190px] overflow-y-auto pr-1 text-[16.5px] leading-snug text-ink-100">
        {value ?? <span className="break-all font-mono text-[13px] text-ink-400">— {path}</span>}
      </div>
    </div>
  );
}

/* Expected (ground truth) ↔ actual (generated) workflow matching */
function Matching({ run }: { run: Run }) {
  const gt = run.groundTruth;
  const gen = run.generatedWorkflows;
  const ready = gt !== null && gen !== null;
  const rows = ready ? Math.max(gt.length, gen.length) : 4;
  const rowH = 64;
  const height = rows * rowH + 8;

  const left: (WorkflowRecord | null)[] = ready ? gt : Array(rows).fill(null);
  const right: (WorkflowRecord | null)[] = ready ? gen : Array(rows).fill(null);

  return (
    <div className="w-full max-w-[960px]">
      <div className="mb-4 flex items-center justify-between">
        <Eyebrow size="xl">Expected workflows ↔ agent output</Eyebrow>
        {!ready && <Badge size="lg" kind="placeholder" />}
      </div>
      <div className="relative grid grid-cols-[1fr_140px_1fr]" style={{ height }}>
        <Column items={left} label="ground truth" rowH={rowH} />
        <svg className="h-full w-full" viewBox={`0 0 200 ${height}`} preserveAspectRatio="none">
          {left.map((l, i) => {
            const target = ready && l ? right.findIndex((r) => r?.matchedTo === l.id) : i;
            if (target < 0) return null;
            const y0 = i * rowH + rowH / 2;
            const y1 = target * rowH + rowH / 2;
            return (
              <path
                key={i}
                d={`M 0 ${y0} C 100 ${y0}, 100 ${y1}, 200 ${y1}`}
                fill="none"
                stroke={ready ? 'rgb(var(--signal))' : 'rgb(var(--ink-500))'}
                strokeWidth="2.5"
                className={ready ? '' : 'dash-flow'}
              />
            );
          })}
        </svg>
        <Column items={right} label="generated" rowH={rowH} />
      </div>
      {!ready && (
        <div className="mt-3 text-center font-mono text-[13px] text-ink-400">
          matching appears when groundTruth and generatedWorkflows are in the run JSON · slot count is illustrative
        </div>
      )}
    </div>
  );
}

function Column({ items, label, rowH }: { items: (WorkflowRecord | null)[]; label: string; rowH: number }) {
  return (
    <div className="flex min-w-0 flex-col">
      {items.map((w, i) => (
        <div key={i} className="flex min-w-0 items-center" style={{ height: rowH }}>
          {w ? (
            <div title={w.title} className="w-full min-w-0 truncate rounded-xl border border-ink-600 bg-ink-900 px-4 py-3 text-[18px] text-ink-100">{w.title}</div>
          ) : (
            <div className="flex w-full items-center justify-between rounded-lg border border-dashed border-ink-700 px-3 py-2 font-mono text-[13px] text-ink-500">
              <span>{label}</span>
              <span>—</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
