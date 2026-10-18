import { AnimatePresence, animate, motion, useMotionValue, useTransform } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';

export type Provenance = 'recorded' | 'live' | 'simulated' | 'placeholder' | 'derived';

const BADGE: Record<Provenance, { label: string; cls: string; dot: ReactNode }> = {
  recorded: {
    label: 'Recorded',
    cls: 'border-ink-600 text-ink-100',
    dot: <span className="h-1.5 w-1.5 rounded-full bg-signal" />,
  },
  live: {
    label: 'Live',
    cls: 'border-signal/60 bg-signal/10 text-signal',
    dot: <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-signal" />,
  },
  derived: {
    label: 'Derived',
    cls: 'border-ink-600 text-ink-200',
    dot: <span className="h-1.5 w-1.5 rounded-full border border-signal" />,
  },
  simulated: {
    label: 'Preview',
    cls: 'border-signal/50 text-signal hatch',
    dot: <span className="h-1.5 w-1.5 rotate-45 bg-signal" />,
  },
  placeholder: {
    label: 'Not in artifact',
    cls: 'border-dashed border-ink-500 text-ink-300',
    dot: <span className="h-1.5 w-1.5 rounded-full border border-dashed border-ink-400" />,
  },
};

export function Badge({ kind, label, size = 'md' }: { kind: Provenance; label?: string; size?: 'md' | 'lg' }) {
  const b = BADGE[kind];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono ${size === 'lg' ? 'text-[12.5px]' : 'text-[10.5px]'} uppercase tracking-[0.12em] ${b.cls}`}
    >
      {b.dot}
      {label ?? b.label}
    </span>
  );
}

/** Inline placeholder for a value that is not in the evaluation artifacts. */
export function Missing({ path, size = 'md' }: { path: string; size?: 'sm' | 'md' }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-md border border-dashed border-ink-500/80 ${
        size === 'sm' ? 'px-1.5 py-0.5 text-[13px]' : 'px-2 py-1 text-[14px]'
      } font-mono text-ink-400`}
      title={`Will be read from ${path}`}
    >
      <span className="text-ink-300">—</span>
      <span className="truncate">{path}</span>
    </span>
  );
}

/** Block placeholder for a whole section that awaits artifacts. */
export function MissingBlock({ title, path, children }: { title: string; path: string; children?: ReactNode }) {
  return (
    <div className="hatch-muted rounded-xl border border-dashed border-ink-600 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15.5px] text-ink-200">{title}</span>
        <Badge kind="placeholder" />
      </div>
      <div className="mt-2 font-mono text-[13px] text-ink-400">source → {path}</div>
      {children}
    </div>
  );
}

/** `size="lg"` is the larger type scale (used on the Load page); the default is unchanged. */
export type UiSize = 'md' | 'lg' | 'xl';

export function Eyebrow({ children, className = '', size = 'md' }: { children: ReactNode; className?: string; size?: UiSize }) {
  return (
    <div className={`font-mono ${size === 'xl' ? 'text-[16px]' : size === 'lg' ? 'text-[14px]' : 'text-[11px]'} uppercase tracking-[0.18em] text-ink-400 ${className}`}>{children}</div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-ink-600 bg-ink-850 px-1.5 font-mono text-[12px] text-ink-300">
      {children}
    </kbd>
  );
}

/** Number that animates between values. Used only to transition between recorded values. */
export function CountUp({
  value,
  duration = 1.1,
  format = (n: number) => Math.round(n).toString(),
  className = '',
}: {
  value: number;
  duration?: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => format(v));
  useEffect(() => {
    const c = animate(mv, value, { duration, ease: [0.22, 1, 0.36, 1] });
    return () => c.stop();
  }, [value, duration, mv]);
  return <motion.span className={`tnum ${className}`}>{text}</motion.span>;
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  className = '',
  size = 'md',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  size?: UiSize;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`group inline-flex items-center gap-2 rounded-full bg-signal ${size === 'xl' ? 'px-6 py-3 text-[18px]' : size === 'lg' ? 'px-5 py-2.5 text-[16px]' : 'px-4 py-2 text-[13px]'} font-semibold text-on-signal transition hover:shadow-[0_0_28px_-4px_rgb(var(--signal)/0.7)] disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  active,
  className = '',
  size = 'md',
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  className?: string;
  size?: UiSize;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border ${size === 'xl' ? 'px-5 py-2.5 text-[18px]' : size === 'lg' ? 'px-4 py-2 text-[16px]' : 'px-3.5 py-1.5 text-[13px]'} transition ${
        active
          ? 'border-signal/60 bg-signal/10 text-signal'
          : 'border-ink-600 text-ink-200 hover:border-ink-400 hover:text-ink-50'
      } ${className}`}
    >
      {children}
    </button>
  );
}

export function PlayIcon() {
  return (
    <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor" aria-hidden>
      <path d="M0 0 L10 6 L0 12 Z" />
    </svg>
  );
}

export function ArrowRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M2 7h10M8 3l4 4-4 4" />
    </svg>
  );
}

/** Custom dropdown matching the app's own styling — never the browser's native <select> chrome. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  disabled,
  placeholder = 'select…',
  className = '',
  direction = 'down',
  size = 'md',
}: {
  value: T | '';
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** 'up' for selects near the bottom edge, where a downward list would be clipped. */
  direction?: 'down' | 'up';
  size?: UiSize;
}) {
  const [open, setOpen] = useState(false);
  const text = size === 'xl' ? 'text-[19px]' : size === 'lg' ? 'text-[16px]' : 'text-[13px]';
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border bg-ink-900 px-3.5 ${size === 'xl' ? 'py-3' : size === 'lg' ? 'py-2.5' : 'py-2'} font-mono ${text} transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          open ? 'border-signal/50' : 'border-ink-700 hover:border-ink-500'
        }`}
      >
        <span className={`truncate ${current ? 'text-ink-100' : 'text-ink-400'}`}>{current?.label ?? placeholder}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" className={`shrink-0 text-ink-400 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}>
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul
            initial={{ opacity: 0, y: direction === 'up' ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: direction === 'up' ? 4 : -4 }}
            transition={{ duration: 0.12 }}
            className={`absolute z-30 max-h-60 ${direction === 'up' ? 'bottom-full mb-1.5' : 'mt-1.5'} w-max min-w-full overflow-y-auto rounded-lg border border-ink-700 bg-ink-900 p-1 shadow-[0_12px_32px_-8px_rgb(var(--shadow)/0.4)]`}
          >
            {options.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center whitespace-nowrap rounded-md px-2.5 py-1.5 text-left font-mono ${text} transition-colors ${
                    o.value === value ? 'bg-signal/10 text-signal' : 'text-ink-200 hover:bg-ink-850'
                  }`}
                >
                  {o.label}
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
