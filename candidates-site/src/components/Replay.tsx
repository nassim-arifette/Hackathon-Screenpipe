import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { candidates, sonnetReview, timelines, type CandidateId, type TimelineEvent } from '../data'

const ORDER: CandidateId[] = ['baseline', 'conflict', 'preflight']
const PLAY_MS = 14000

type WsEvent = Extract<TimelineEvent, { k: 'ws' }>

function lastT(id: CandidateId) {
  return Math.max(sonnetReview[id].seconds, ...timelines[id].map((e) => e.t))
}

function clusterOffsets(evs: TimelineEvent[]) {
  const offsets = new Map<TimelineEvent, number>()
  let prevT = -Infinity
  let k = 0
  for (const e of evs) {
    if (e.k !== 'ws') continue
    k = e.t - prevT < 2.5 ? k + 1 : 0
    offsets.set(e, k * 14)
    prevT = e.t
  }
  return offsets
}

const ACTION_LETTER: Record<string, string> = { context: 'C', publish: 'P', handoff: 'H', finish: 'F' }

function shortMsg(msg?: string) {
  if (!msg) return ''
  return msg.replace('Workflow operation failed: ', '')
}

export function Replay() {
  const horizon = useMemo(() => Math.ceil(Math.max(...ORDER.map(lastT)) / 10) * 10 + 5, [])
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selected, setSelected] = useState<{ id: CandidateId; e: WsEvent } | null>(null)
  const raf = useRef<number>()
  const started = useRef<number>()
  const root = useRef<HTMLDivElement>(null)
  const autoplayed = useRef(false)

  useEffect(() => {
    if (!playing) return
    const startT = t >= horizon ? 0 : t
    started.current = performance.now() - (startT / horizon) * PLAY_MS
    const tick = (now: number) => {
      const p = Math.min((now - (started.current ?? now)) / PLAY_MS, 1)
      setT(p * horizon)
      if (p < 1) raf.current = requestAnimationFrame(tick)
      else setPlaying(false)
    }
    raf.current = requestAnimationFrame(tick)
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, horizon])

  useEffect(() => {
    const el = root.current
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !autoplayed.current) {
          autoplayed.current = true
          setTimeout(() => setPlaying(true), 400)
        }
      },
      { threshold: 0.45 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const x = (sec: number) => `${(sec / horizon) * 100}%`

  return (
    <div ref={root} className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-ink-700 px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              if (t >= horizon) setT(0)
              setPlaying((p) => !p)
            }}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-signal text-ink-950 transition hover:scale-105"
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? (
              <svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="1" width="3.5" height="12" fill="currentColor" /><rect x="8.5" y="1" width="3.5" height="12" fill="currentColor" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 1l10 6-10 6z" fill="currentColor" /></svg>
            )}
          </button>
          <div>
            <div className="font-mono text-2xl font-semibold tabular-nums text-ink-50">{t.toFixed(0).padStart(3, '0')} s</div>
            <div className="eyebrow">real wall-clock · replayed ×{(horizon / (PLAY_MS / 1000)).toFixed(0)}</div>
          </div>
        </div>
        <input
          type="range"
          min={0}
          max={horizon}
          step={0.5}
          value={t}
          onChange={(e) => {
            setPlaying(false)
            setT(Number(e.target.value))
          }}
          className="w-full max-w-md accent-[#C8FF4D] md:w-1/2"
        />
        <div className="flex flex-wrap gap-3 font-mono text-[11px] text-ink-300">
          <span className="flex items-center gap-1.5"><i className="h-3 w-0.5 bg-ink-400" />model request</span>
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-signal" />workspace call ok</span>
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-cost" />refused</span>
        </div>
      </div>

      <div className="space-y-1 px-6 py-6">
        {ORDER.map((id) => {
          const c = candidates[id]
          const evs = timelines[id]
          const end = lastT(id)
          const reqs = evs.filter((e) => e.k === 'req' && e.t <= t).length
          const fails = evs.filter((e) => e.k === 'ws' && !e.ok && e.t <= t).length
          const out = evs.reduce((a, e) => (e.k === 'usage' && e.t <= t ? a + e.out : a), 0)
          const done = t >= end
          const offsets = clusterOffsets(evs)
          return (
            <div key={id} className="grid grid-cols-1 items-center gap-4 py-3 md:grid-cols-[200px_1fr_240px]">
              <div>
                <div className="font-mono text-[13px] font-semibold" style={{ color: c.color }}>{c.name}</div>
                <div className="eyebrow mt-0.5">{c.label}</div>
              </div>

              <div className="relative h-14 rounded-lg bg-ink-900">
                <div className="absolute inset-y-0 left-0 rounded-lg" style={{ width: x(Math.min(t, end)), background: `${c.color}10` }} />
                {evs.map((e, i) => {
                  if (e.t > t) return null
                  if (e.k === 'req')
                    return (
                      <motion.div
                        key={i}
                        initial={{ scaleY: 0 }}
                        animate={{ scaleY: 1 }}
                        className="absolute top-1.5 h-3 w-[2px] origin-top bg-ink-400"
                        style={{ left: x(e.t) }}
                      />
                    )
                  if (e.k === 'ws') {
                    const isSel = selected?.id === id && selected.e === e
                    return (
                      <motion.button
                        key={i}
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 18 }}
                        onClick={() => setSelected(isSel ? null : { id, e })}
                        className={`absolute top-[26px] flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full font-mono text-[9px] font-bold text-ink-950 ${e.ok ? 'bg-signal' : 'bg-cost ring-4 ring-cost/25'} ${isSel ? 'outline outline-2 outline-offset-2 outline-ink-50' : ''}`}
                        style={{ left: `calc(${x(e.t)} + ${offsets.get(e) ?? 0}px)` }}
                        title={`${e.action} · ${e.ok ? 'ok' : 'refused'}`}
                      >
                        {e.ok ? ACTION_LETTER[e.action] ?? '·' : '✕'}
                      </motion.button>
                    )
                  }
                  return null
                })}
                {done && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="absolute top-0 h-full border-r-2 border-dashed"
                    style={{ left: x(end), borderColor: c.color }}
                  />
                )}
                <div className="absolute top-0 h-full w-px bg-ink-50/80" style={{ left: x(Math.min(t, horizon)) }} />
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-ink-900 py-1.5">
                  <div className="font-semibold tabular-nums text-ink-50">{reqs}</div>
                  <div className="font-mono text-[9px] uppercase text-ink-300">requests</div>
                </div>
                <div className="rounded-lg bg-ink-900 py-1.5">
                  <div className={`font-semibold tabular-nums ${fails ? 'text-cost' : 'text-signal'}`}>{fails}</div>
                  <div className="font-mono text-[9px] uppercase text-ink-300">refused</div>
                </div>
                <div className="rounded-lg bg-ink-900 py-1.5">
                  <div className="font-semibold tabular-nums text-ink-50">{done ? `${Math.round(end)} s` : `${(out / 1000).toFixed(1)}k`}</div>
                  <div className="font-mono text-[9px] uppercase text-ink-300">{done ? 'finished' : 'out tok'}</div>
                </div>
              </div>
            </div>
          )
        })}
        <div className="relative ml-0 h-5 md:ml-[216px] md:mr-[256px]">
          {Array.from({ length: Math.floor(horizon / 20) + 1 }, (_, i) => i * 20).map((s) => (
            <span key={s} className="absolute -translate-x-1/2 font-mono text-[10px] text-ink-400" style={{ left: x(s) }}>
              {s}s
            </span>
          ))}
        </div>
      </div>

      <div className="min-h-[86px] border-t border-ink-700 bg-ink-900/60 px-6 py-4">
        <AnimatePresence mode="wait">
          {selected ? (
            <motion.div key={`${selected.id}-${selected.e.t}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <div className="eyebrow mb-1.5">
                {candidates[selected.id].name} · t = {selected.e.t}s · {selected.e.action} · {selected.e.ok ? 'ok' : 'refused'}
              </div>
              <div className={`font-mono text-[12px] leading-relaxed ${selected.e.ok ? 'text-signal' : 'text-cost'}`}>
                {selected.e.ok ? `workflow_workspace.${selected.e.action} → ok` : shortMsg(selected.e.msg)}
              </div>
            </motion.div>
          ) : (
            <motion.div key="hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="font-mono text-[12px] text-ink-300">
              Click any workspace call to read the engine's reply. C = context · H = handoff · P = publish · F = finish
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
