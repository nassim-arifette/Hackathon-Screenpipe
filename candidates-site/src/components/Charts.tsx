import { motion } from 'framer-motion'

export function Reveal({ children, delay = 0, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}

export function CompareBars({
  title,
  unit,
  rows,
  format = (v) => `${v}`,
  lowerIsBetter = true,
}: {
  title: string
  unit?: string
  rows: { label: string; value: number; color: string; strong?: boolean }[]
  format?: (v: number) => string
  lowerIsBetter?: boolean
}) {
  const max = Math.max(...rows.map((r) => r.value), 1)
  const best = lowerIsBetter ? Math.min(...rows.map((r) => r.value)) : Math.max(...rows.map((r) => r.value))
  const base = rows[0].value
  return (
    <div className="card p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <span className="text-sm font-medium text-ink-50">{title}</span>
        {unit && <span className="eyebrow">{unit}</span>}
      </div>
      <div className="space-y-3">
        {rows.map((r, i) => {
          const delta = i === 0 || base === 0 ? null : Math.round(((r.value - base) / base) * 100)
          return (
            <div key={r.label} className="grid grid-cols-[150px_1fr_112px] items-center gap-3">
              <span className={`truncate font-mono text-[11px] ${r.strong ? 'text-ink-50' : 'text-ink-300'}`}>{r.label}</span>
              <div className="h-6 overflow-hidden rounded-md bg-ink-900">
                <motion.div
                  className="h-full rounded-md"
                  style={{ background: r.color, opacity: r.value === best ? 1 : 0.55 }}
                  initial={{ width: 0 }}
                  whileInView={{ width: `${Math.max((r.value / max) * 100, r.value === 0 ? 0 : 2)}%` }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.9, delay: 0.1 + i * 0.12, ease: [0.22, 1, 0.36, 1] }}
                />
              </div>
              <div className="whitespace-nowrap text-right">
                <span className="font-semibold tabular-nums text-ink-50">{format(r.value)}</span>
                {delta !== null && (
                  <span className={`ml-1.5 font-mono text-[10px] ${delta < 0 ? 'text-signal' : delta > 0 ? 'text-cost' : 'text-ink-300'}`}>
                    {delta > 0 ? '+' : delta < 0 ? '−' : ''}
                    {Math.abs(delta)}%
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function RangeBands({
  title,
  unit,
  series,
  format = (v) => `${v}`,
}: {
  title: string
  unit?: string
  series: { label: string; values: number[]; color: string }[]
  format?: (v: number) => string
}) {
  const all = series.flatMap((s) => s.values)
  const lo = 0
  const hi = Math.max(...all) * 1.08
  const x = (v: number) => ((v - lo) / (hi - lo)) * 100
  return (
    <div className="card p-5">
      <div className="mb-5 flex items-baseline justify-between">
        <span className="text-sm font-medium text-ink-50">{title}</span>
        {unit && <span className="eyebrow">{unit}</span>}
      </div>
      <div className="space-y-5">
        {series.map((s, si) => {
          const min = Math.min(...s.values)
          const max = Math.max(...s.values)
          const mean = s.values.reduce((a, b) => a + b, 0) / s.values.length
          return (
            <div key={s.label}>
              <div className="mb-1.5 flex justify-between font-mono text-[11px]">
                <span className="text-ink-200">{s.label}</span>
                <span className="text-ink-300">
                  {format(min)}–{format(max)} · mean <span className="text-ink-50">{format(Math.round(mean * 10) / 10)}</span>
                </span>
              </div>
              <div className="relative h-7 rounded-md bg-ink-900">
                <motion.div
                  className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full"
                  style={{ left: `${x(min)}%`, background: s.color, opacity: 0.35 }}
                  initial={{ width: 0 }}
                  whileInView={{ width: `${Math.max(x(max) - x(min), 0.8)}%` }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.8, delay: si * 0.15 }}
                />
                {s.values.map((v, i) => (
                  <motion.div
                    key={i}
                    className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink-950"
                    style={{ left: `${x(v)}%`, background: s.color }}
                    initial={{ scale: 0 }}
                    whileInView={{ scale: 1 }}
                    viewport={{ once: true }}
                    transition={{ delay: 0.5 + si * 0.15 + i * 0.08, type: 'spring', stiffness: 300 }}
                  />
                ))}
                <div className="absolute top-0 h-full w-px bg-ink-50/70" style={{ left: `${x(mean)}%` }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function Stat({ value, label, sub, tone = 'signal' }: { value: string; label: string; sub?: string; tone?: 'signal' | 'cost' | 'muted' }) {
  const color = tone === 'signal' ? 'text-signal' : tone === 'cost' ? 'text-cost' : 'text-ink-50'
  return (
    <div className="card h-full p-5">
      <div className={`text-4xl font-semibold tracking-tight tabular-nums md:text-5xl ${color}`}>{value}</div>
      <div className="mt-2 text-sm text-ink-50">{label}</div>
      {sub && <div className="mt-1 font-mono text-[11px] text-ink-300">{sub}</div>}
    </div>
  )
}
