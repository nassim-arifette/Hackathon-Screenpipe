import { motion } from 'framer-motion';

const STAGES = ['Discover', 'Maintain', 'Deepen', 'Review'];
const EASE = [0.22, 1, 0.36, 1] as const;

/** Product landing page. Establishes identity only — no experiment data, no scores,
 *  no backend calls. Clicking through opens the real evaluation workspace (App's
 *  `entered` gate), which is where runs, requests, runtime and checks live. */
export function Landing({ onEnter }: { onEnter: () => void }) {
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center px-10">
      <Lifecycle />

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: EASE }}
        className="relative z-10 flex flex-col items-center text-center"
      >
        <span className="flex items-center gap-2 font-mono text-[14.5px] uppercase tracking-[0.3em] text-ink-400">
          <img src="/screenpipe-icon.png" alt="" className="h-4 w-4 rounded-[5px] opacity-90" />
          Screenpipe Workflows
        </span>
        <h1 className="mt-5 text-[120px] font-semibold leading-[0.92] tracking-tightest text-ink-50">PipeOps</h1>
        <p className="mt-4 text-[29px] font-medium text-signal">Prove It Before You Ship It.</p>
        <p className="mt-6 max-w-[620px] text-[20px] leading-relaxed text-ink-300">
          The testing ground for AI-powered workflows.
        </p>

        <motion.button
          onClick={onEnter}
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.98 }}
          className="group mt-12 inline-flex items-center gap-3 rounded-full bg-signal px-7 py-3.5 text-[19px] font-semibold text-on-signal transition hover:shadow-[0_0_40px_-6px_rgb(var(--signal)/0.75)]"
        >
          Enter the Lab
          <span className="transition-transform group-hover:translate-x-1">→</span>
        </motion.button>
      </motion.div>

      <span className="absolute bottom-8 font-mono text-[13px] tracking-widest text-ink-500">
        Hackathon · Build Agents That Remember
      </span>
    </div>
  );
}

/** Subtle, looping visualization of the agent lifecycle — purely decorative, no data. */
function Lifecycle() {
  const r = 300;
  const n = STAGES.length;
  const pos = (i: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  };
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-[0.55]">
      <svg width={r * 2 + 220} height={r * 2 + 220} viewBox={`${-r - 110} ${-r - 110} ${r * 2 + 220} ${r * 2 + 220}`}>
        <defs>
          <filter id="land-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle r={r} fill="none" stroke="rgb(var(--ink-700))" strokeWidth="1" strokeDasharray="2 10" />
        {STAGES.map((_, i) => {
          const a = pos(i);
          const b = pos((i + 1) % n);
          return (
            <motion.path
              key={i}
              d={`M ${a.x} ${a.y} A ${r} ${r} 0 0 1 ${b.x} ${b.y}`}
              fill="none"
              stroke="rgb(var(--signal))"
              strokeWidth="2"
              filter="url(#land-glow)"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 0.8 }}
              transition={{ duration: 1.1, delay: i * 0.5, ease: EASE, repeat: Infinity, repeatDelay: n * 0.5 + 1.2, repeatType: 'loop' }}
            />
          );
        })}
        {STAGES.map((name, i) => {
          const p = pos(i);
          return (
            <g key={name} transform={`translate(${p.x} ${p.y})`}>
              <motion.circle
                r="5"
                fill="rgb(var(--ink-950))"
                stroke="rgb(var(--signal))"
                strokeWidth="1.5"
                animate={{ scale: [1, 1.5, 1], opacity: [0.7, 1, 0.7] }}
                transition={{ duration: 2.2, delay: i * 0.5, repeat: Infinity, ease: 'easeInOut' }}
              />
              <text
                y={p.y < -1 ? -22 : p.y > 1 ? 34 : 6}
                x={p.x < -1 ? -14 : p.x > 1 ? 14 : 0}
                textAnchor={p.x < -1 ? 'end' : p.x > 1 ? 'start' : 'middle'}
                className="font-mono"
                fontSize="13"
                letterSpacing="0.14em"
                fill="rgb(var(--ink-300))"
              >
                {name.toUpperCase()}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
