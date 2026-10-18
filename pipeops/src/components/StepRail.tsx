import { motion } from 'framer-motion';
import { pad2 } from '../lib/format';
import { Kbd } from './ui';

export const STEPS = [
  { key: 'load', label: 'Load experiment' },
  { key: 'canvas', label: 'Agent execution' },
  { key: 'evidence', label: 'Inspect evaluation' },
  { key: 'compare', label: 'Compare variants' },
  { key: 'replay', label: 'Stage replay' },
] as const;

export function StepRail({ step, loaded, onStep }: { step: number; loaded: boolean; onStep: (i: number) => void }) {
  return (
    <footer className="relative z-20 flex h-[84px] shrink-0 items-center gap-10 border-t border-ink-800/80 bg-ink-950/60 px-10 backdrop-blur">
      <nav className="relative flex flex-1 items-center">
        {STEPS.map((s, i) => {
          const active = i === step;
          const done = i < step;
          const locked = i > 0 && !loaded;
          return (
            <div key={s.key} className="flex flex-1 items-center last:flex-none">
              <button
                onClick={() => onStep(i)}
                className={`group flex items-center gap-3 rounded-full py-1.5 pl-1.5 pr-4 transition ${
                  active ? 'bg-ink-850' : 'hover:bg-ink-900'
                }`}
              >
                <span
                  className={`relative flex h-7 w-7 items-center justify-center rounded-full border font-mono text-[13px] transition ${
                    active
                      ? 'border-signal bg-signal text-on-signal'
                      : done
                        ? 'border-signal/60 text-signal'
                        : 'border-ink-600 text-ink-400'
                  }`}
                >
                  {pad2(i + 1)}
                  {active && (
                    <motion.span
                      layoutId="step-glow"
                      className="absolute inset-[-5px] rounded-full border border-signal/40"
                      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                    />
                  )}
                </span>
                <span
                  className={`whitespace-nowrap text-[16.5px] transition ${
                    active ? 'font-medium text-ink-50' : locked ? 'text-ink-400' : 'text-ink-300 group-hover:text-ink-100'
                  }`}
                >
                  {s.label}
                </span>
              </button>
              {i < STEPS.length - 1 && (
                <div className="relative mx-3 h-px flex-1 bg-ink-700">
                  <motion.div
                    className="absolute inset-y-0 left-0 bg-signal/70"
                    initial={false}
                    animate={{ width: i < step ? '100%' : '0%' }}
                    transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <div className="flex items-center gap-5 font-mono text-[13px] text-ink-400">
        <span className="flex items-center gap-1.5">
          <Kbd>←</Kbd>
          <Kbd>→</Kbd> steps
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>space</Kbd> play
        </span>
      </div>
    </footer>
  );
}

