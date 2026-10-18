import { motion } from 'framer-motion'
import { candidates, type CandidateId } from '../data'

type Step = { kind: 'agent' | 'engine' | 'fail' | 'ok' | 'waste'; title: string; detail?: string; changed?: boolean }

const flows: Record<CandidateId, Step[]> = {
  baseline: [
    { kind: 'agent', title: 'Read drafts', detail: 'context' },
    { kind: 'agent', title: 'Publish draft', detail: 'publish' },
    { kind: 'fail', title: '422 · Stage 1 retained 0 of 3 items', detail: 'Verdict arrives after the write attempt' },
    { kind: 'agent', title: 'Re-read evidence, fix, publish again' },
    { kind: 'fail', title: '409 · Workspace changed', detail: '"Read context before publishing."' },
    { kind: 'agent', title: 'Read context again → retry', detail: 'extra round-trip' },
    { kind: 'ok', title: 'Published', detail: 'publish' },
    { kind: 'waste', title: 'finish → one more summary turn', detail: 'extra request, nothing changes' },
  ],
  conflict: [
    { kind: 'agent', title: 'Read drafts', detail: 'context' },
    { kind: 'agent', title: 'Publish draft', detail: 'publish' },
    { kind: 'fail', title: '422 · Stage 1 retained 0 of 3 items', detail: 'Same as baseline' },
    { kind: 'agent', title: 'Re-read evidence, fix, publish again' },
    { kind: 'engine', title: '409 + current revision + open drafts', detail: 'Current revision: 9 · your open drafts: [...]', changed: true },
    { kind: 'agent', title: 'Retry at revision 9 directly', detail: 'no context read', changed: true },
    { kind: 'ok', title: 'Published', detail: 'publish' },
    { kind: 'engine', title: 'finish ends Review', detail: 'no summary turn', changed: true },
  ],
  preflight: [
    { kind: 'engine', title: 'Read drafts + publicationCheck', detail: 'dry run of the real publish validation, no write, no lock', changed: true },
    { kind: 'engine', title: '{ ok: false, problems: "procedure[0]: quote is not in…" }', detail: 'the 422 Review would have hit, before sending', changed: true },
    { kind: 'agent', title: 'Fix the draft, hand it off', detail: 'handoff' },
    { kind: 'engine', title: 'publicationCheck { ok: true }', changed: true },
    { kind: 'ok', title: 'Published first time', detail: 'publish ×2, 0 refused' },
    { kind: 'engine', title: 'If 409: revision included', detail: 'same as conflict-revision', changed: true },
    { kind: 'engine', title: 'finish ends Review', detail: 'no summary turn', changed: true },
  ],
}

const kindStyle: Record<Step['kind'], { dot: string; text: string; border: string }> = {
  agent: { dot: 'bg-ink-400', text: 'text-ink-50', border: 'border-ink-700' },
  engine: { dot: 'bg-signal', text: 'text-ink-50', border: 'border-signal/40' },
  fail: { dot: 'bg-cost', text: 'text-cost', border: 'border-cost/40' },
  ok: { dot: 'bg-signal', text: 'text-signal', border: 'border-signal/30' },
  waste: { dot: 'bg-cost/60', text: 'text-ink-200', border: 'border-dashed border-cost/40' },
}

export function ArchitectureColumn({ id, index }: { id: CandidateId; index: number }) {
  const c = candidates[id]
  const steps = flows[id]
  const isOurs = id === 'preflight'
  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.6, delay: index * 0.12 }}
      className={`card relative flex flex-col p-6 ${isOurs ? 'border-signal/50 shadow-[0_0_80px_-30px_rgba(200,255,77,0.45)]' : ''}`}
    >
      {isOurs && (
        <span className="absolute -top-3 left-6 rounded-full bg-signal px-3 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-950">
          our candidate
        </span>
      )}
      <div className="eyebrow" style={{ color: c.color }}>
        {c.label}
      </div>
      <h3 className="mt-1 font-mono text-lg font-semibold text-ink-50">{c.name}</h3>
      <p className="mt-2 min-h-[72px] text-sm leading-relaxed text-ink-200">{c.summary}</p>

      <motion.ol className="relative mt-6 space-y-2.5" initial="hidden" whileInView="shown" viewport={{ once: true, amount: 0.1 }}>
        <div className="absolute bottom-3 left-[7px] top-3 w-px bg-ink-700" />
        {steps.map((s, i) => {
          const st = kindStyle[s.kind]
          return (
            <motion.li
              key={i}
              variants={{ hidden: { opacity: 0, x: -10 }, shown: { opacity: 1, x: 0, transition: { delay: 0.3 + index * 0.12 + i * 0.07 } } }}
              className="relative flex gap-3"
            >
              <span className={`relative z-10 mt-3 h-[15px] w-[15px] shrink-0 rounded-full border-[3px] border-ink-800 ${st.dot}`} />
              <div className={`flex-1 rounded-lg border bg-ink-900/80 px-3 py-2 ${st.border}`}>
                <div className={`flex items-start justify-between gap-2 text-[13px] font-medium ${st.text} ${s.kind === 'engine' || s.kind === 'fail' ? 'font-mono text-[12px]' : ''}`}>
                  <span>{s.title}</span>
                  {s.changed && (
                    <span className="shrink-0 rounded bg-signal/15 px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-signal">engine</span>
                  )}
                </div>
                {s.detail && <div className="mt-0.5 font-mono text-[11px] text-ink-300">{s.detail}</div>}
              </div>
            </motion.li>
          )
        })}
      </motion.ol>
    </motion.div>
  )
}
