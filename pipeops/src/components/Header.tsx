import { motion } from 'framer-motion';
import type { DataOrigin } from '../data/load';
import type { Experiment, Run } from '../data/schema';
import { Badge } from './ui';

export function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden>
      <circle cx="4" cy="13" r="3" fill="rgb(var(--signal))" />
      <circle cx="13" cy="5" r="2.4" stroke="rgb(var(--signal))" strokeWidth="1.4" />
      <circle cx="13" cy="21" r="2.4" stroke="rgb(var(--signal))" strokeWidth="1.4" />
      <circle cx="22" cy="13" r="3" stroke="rgb(var(--signal))" strokeWidth="1.4" />
      <path d="M6.5 11.5 L11 6.5 M6.5 14.5 L11 19.5 M15 6.5 L19.6 11.4 M15 19.5 L19.6 14.6" stroke="rgb(var(--signal))" strokeOpacity=".55" strokeWidth="1.2" />
    </svg>
  );
}

const ORIGIN_LABEL: Record<DataOrigin, { label: string; tone: 'recorded' | 'live' | 'placeholder' }> = {
  recorded: { label: 'Recorded experiment', tone: 'recorded' },
  demo: { label: 'Demo experiment', tone: 'recorded' },
  live: { label: 'Live experiment · just ran', tone: 'live' },
  mock: { label: 'Mock placeholder', tone: 'placeholder' },
};

export function Header({
  experiment,
  origin,
  runs,
  activeRunId,
  onRun,
  step,
}: {
  experiment: Experiment;
  origin: DataOrigin | null;
  runs: Run[];
  activeRunId: string | null;
  onRun: (id: string) => void;
  step: number;
}) {
  // The run switcher is meaningless on the comparison step (both runs are on screen).
  const showSwitcher = activeRunId !== null && step !== 3;
  const o = ORIGIN_LABEL[origin ?? 'recorded'];
  return (
    <header className="relative z-20 flex h-[72px] shrink-0 items-center justify-between border-b border-ink-800/80 pl-10 pr-[88px]">
      <div className="flex items-center gap-4">
        <Logo />
        <span className="text-[20px] font-semibold tracking-tight text-ink-50">PipeOps</span>
        <span className="text-ink-500">/</span>
        <span className="flex items-center gap-1.5 text-[16.5px] text-ink-300">
          <img src="/screenpipe-icon.png" alt="" className="h-8 w-8 rounded-[9px]" />
          {experiment.experiment.subject}
        </span>
      </div>

      <div className="absolute left-1/2 -translate-x-1/2">
        {showSwitcher ? (
          <div className="relative flex rounded-full border border-ink-700 bg-ink-900/80 p-1">
            {runs.map((r) => {
              const active = r.id === activeRunId;
              return (
                <button
                  key={`${r.id}-${r.role}`}
                  onClick={() => onRun(r.id)}
                  className={`relative z-10 rounded-full px-4 py-1.5 text-[15.5px] transition-colors ${
                    active ? 'text-ink-950' : 'text-ink-300 hover:text-ink-100'
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="run-pill"
                      className="absolute inset-0 -z-10 rounded-full bg-signal"
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  )}
                  <span className="font-medium">{r.label}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <span className="font-mono text-[14.5px] tracking-wide text-ink-400">
            {step === 3 ? 'paired comparison · 2 runs' : 'no run loaded'}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Badge size="lg" kind={o.tone} label={o.label} />
      </div>
    </header>
  );
}
