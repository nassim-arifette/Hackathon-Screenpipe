import { motion } from 'framer-motion'
import { ArchitectureColumn } from './components/Architecture'
import { Replay } from './components/Replay'
import { CompareBars, RangeBands, Reveal, Stat } from './components/Charts'
import { candidates, fmtK, gptFullRun, gptReviewRuns, messages, pct, sonnetRejections, sonnetReview, sonnetStages, type CandidateId } from './data'

const IDS: CandidateId[] = ['baseline', 'conflict', 'preflight']
const s = sonnetReview

function Section({ id, eyebrow, title, lead, children }: { id: string; eyebrow: string; title: React.ReactNode; lead?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="mx-auto max-w-6xl px-6 py-24">
      <Reveal>
        <div className="eyebrow text-signal">{eyebrow}</div>
        <h2 className="mt-3 max-w-3xl text-3xl font-semibold tracking-tight text-ink-50 md:text-5xl">{title}</h2>
        {lead && <p className="mt-4 max-w-2xl text-base leading-relaxed text-ink-200">{lead}</p>}
      </Reveal>
      <div className="mt-12">{children}</div>
    </section>
  )
}

function SampleNote({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 font-mono text-[11px] text-ink-300">{children}</p>
}

function Nav() {
  const links = [
    ['architecture', 'Architecture'],
    ['replay', 'Replay'],
    ['review', 'Review data'],
    ['repeats', 'Repeats'],
    ['fullrun', 'Full run'],
    ['stages', 'All stages'],
  ]
  return (
    <nav className="sticky top-0 z-50 border-b border-ink-800 bg-ink-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <a href="#top" className="flex items-center gap-2 font-semibold">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-signal font-mono text-[11px] font-bold text-ink-950">P</span>
          PipeOps <span className="text-ink-400">/ Review candidates</span>
        </a>
        <div className="hidden gap-5 text-sm text-ink-300 md:flex">
          {links.map(([h, l]) => (
            <a key={h} href={`#${h}`} className="transition hover:text-ink-50">{l}</a>
          ))}
        </div>
      </div>
    </nav>
  )
}

function Hero() {
  return (
    <header id="top" className="grid-bg relative overflow-hidden border-b border-ink-800">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-signal/10 blur-[120px]" />
      <div className="relative mx-auto max-w-6xl px-6 pb-20 pt-24">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7 }}>
          <div className="flex flex-wrap gap-2">
            <span className="tag">Screenpipe Workflows · Review agent</span>
            <span className="tag">baseline · conflict-revision · preflight-conflict</span>
          </div>
          <h1 className="mt-6 max-w-4xl text-5xl font-semibold leading-[1.02] tracking-tight md:text-7xl">
            Let Review see the verdict <span className="text-signal">before</span> it publishes.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-200">
            <span className="font-mono text-ink-50">preflight-conflict</span> runs the engine's real publish validation as a dry run on every draft read.
            Same quality, zero refused publishes, a much shorter Review.
          </p>
        </motion.div>

        <div className="mt-14 grid grid-cols-2 gap-4 md:grid-cols-4">
          {[
            { v: `${s.baseline.rejected} → 0`, l: 'refused workspace calls', sub: 'Sonnet · Review · 1 run each' },
            { v: `${pct(s.baseline.seconds, s.preflight.seconds)}`, l: `runtime · ${Math.round(s.baseline.seconds)} → ${Math.round(s.preflight.seconds)} s`, sub: 'Sonnet · Review · 1 run each' },
            { v: `${pct(gptFullRun.baseline.requests, gptFullRun.preflight.requests)}`, l: `requests, full run · ${gptFullRun.baseline.requests} → ${gptFullRun.preflight.requests}`, sub: 'GPT · 3 phases · 1 run each' },
            { v: '4 / 4', l: 'GPT Review runs at 11/11, 0 refused', sub: 'GPT · Review · 4 runs' },
          ].map((k, i) => (
            <motion.div key={k.l} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 + i * 0.1 }}>
              <Stat value={k.v} label={k.l} sub={k.sub} />
            </motion.div>
          ))}
        </div>
        <div className="mt-6 flex items-center gap-3">
          <span className="rounded-full bg-signal px-3 py-1 font-mono text-xs font-semibold text-ink-950">11/11 checks</span>
          <span className="text-sm text-ink-300">kept by all three candidates on the Review stage</span>
        </div>
      </div>
    </header>
  )
}

function MessageCompare() {
  const rows = [
    { id: 'baseline' as const, when: 'after a refused publish', lines: [messages.reject422, messages.baseline409] },
    { id: 'conflict' as const, when: 'after a refused publish', lines: [messages.reject422, messages.conflict409] },
    { id: 'preflight' as const, when: 'on the draft read — before any publish', lines: [messages.preflightFail, messages.preflightOk] },
  ]
  return (
    <div className="mt-6 grid gap-4 md:grid-cols-3">
      {rows.map((r, i) => (
        <Reveal key={r.id} delay={i * 0.1}>
          <div className={`card h-full p-5 ${r.id === 'preflight' ? 'border-signal/50' : ''}`}>
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[12px] font-semibold" style={{ color: candidates[r.id].color }}>{candidates[r.id].name}</span>
              <span className="eyebrow">{r.when}</span>
            </div>
            <div className="mt-4 space-y-2">
              {r.lines.map((l, j) => {
                const good = l.includes('"ok": true') || (r.id === 'conflict' && j === 1) || r.id === 'preflight'
                return (
                  <pre key={j} className={`whitespace-pre-wrap break-words rounded-lg border bg-ink-950 p-3 font-mono text-[11px] leading-relaxed ${good ? 'border-signal/30 text-ink-50' : 'border-ink-700 text-ink-300'}`}>
                    {l}
                  </pre>
                )
              })}
            </div>
          </div>
        </Reveal>
      ))}
    </div>
  )
}

export default function App() {
  const colors = { baseline: candidates.baseline.color, conflict: candidates.conflict.color, preflight: candidates.preflight.color }
  const rows = (k: keyof (typeof s)['baseline']) =>
    IDS.map((id) => ({ label: candidates[id].name, value: s[id][k] as number, color: colors[id], strong: id === 'preflight' }))

  return (
    <div className="min-h-screen bg-ink-950 font-sans">
      <Nav />
      <Hero />

      <Section
        id="architecture"
        eyebrow="01 · Architecture"
        title={<>Three engines, one Review loop.</>}
        lead={<>Same agent, same prompt, same snapshot. Only the engine's answers change. Lime blocks are what each candidate changes in the engine.</>}
      >
        <div className="grid gap-6 lg:grid-cols-3">
          {IDS.map((id, i) => <ArchitectureColumn key={id} id={id} index={i} />)}
        </div>
        <Reveal className="mt-14">
          <h3 className="text-xl font-semibold text-ink-50">What the agent actually reads</h3>
          <p className="mt-1 text-sm text-ink-300">Real engine replies from the Sonnet Review runs below.</p>
        </Reveal>
        <MessageCompare />
      </Section>

      <Section
        id="replay"
        eyebrow="02 · Replay"
        title={<>Watch the three Review runs, request by request.</>}
        lead={<>Rebuilt from the raw request logs of the Sonnet Review stage. Every tick is a model request, every dot is a workspace call. Orange is the engine saying no.</>}
      >
        <Reveal><Replay /></Reveal>
        <SampleNote>claude-sonnet-5 · snapshot 20261017T145651Z-baseline-receipts-s1 · stage 04-p1-workflow-review · 1 run per candidate</SampleNote>
      </Section>

      <Section
        id="review"
        eyebrow="03 · Review stage · Sonnet"
        title={<>Same 11/11, less of everything else.</>}
        lead={<>The Review stage replayed from the same saved snapshot, so every candidate starts from identical drafts.</>}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <CompareBars title="Model requests" rows={rows('requests')} />
          <CompareBars title="Runtime" unit="seconds" rows={rows('seconds')} format={(v) => `${Math.round(v)} s`} />
          <CompareBars title="Refused workspace calls" unit="409 / 422 / clipped" rows={rows('rejected')} />
          <CompareBars title="Output tokens" rows={rows('output')} format={fmtK} />
          <CompareBars title="Cache read tokens" rows={rows('cacheRead')} format={fmtK} />
          <CompareBars title="Input tokens" rows={rows('input')} format={fmtK} />
        </div>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {IDS.map((id) => (
            <div key={id} className="card p-5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[12px] font-semibold" style={{ color: colors[id] }}>{candidates[id].name}</span>
                <span className="rounded-full bg-signal/15 px-2 py-0.5 font-mono text-[10px] text-signal">{s[id].checks}</span>
              </div>
              <div className="mt-3 space-y-1.5">
                {sonnetRejections[id].length === 0 ? (
                  <div className="font-mono text-[12px] text-signal">No refused call.</div>
                ) : (
                  sonnetRejections[id].map((r) => (
                    <div key={r.kind} className="flex justify-between font-mono text-[12px] text-ink-200">
                      <span>{r.kind}</span>
                      <span className="text-cost">×{r.n}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
        <SampleNote>
          claude-sonnet-5 · 1 run per candidate · checks graded with the current truth.json (the snapshot's older truth.json gives 10/11 to all three, on missing_date).
        </SampleNote>
      </Section>

      <Section
        id="repeats"
        eyebrow="04 · Repeated runs · GPT"
        title={<>Not a lucky run: 4 out of 4.</>}
        lead={<>We reran the Review stage four times per engine on GPT. Every preflight-conflict run used fewer requests and less cache than every baseline run, and none was refused.</>}
      >
        <div className="grid gap-4 md:grid-cols-2">
          {([
            ['Model requests', 'requests', (v: number) => `${v}`],
            ['Runtime', 'seconds', (v: number) => `${Math.round(v)} s`],
            ['Cache read tokens', 'cacheRead', fmtK],
            ['Refused workspace calls', 'rejected', (v: number) => `${v}`],
          ] as const).map(([title, key, f]) => (
            <RangeBands
              key={key}
              title={title}
              unit="4 runs each"
              format={f}
              series={[
                { label: 'clearer-rejection (baseline)', values: gptReviewRuns.baseline.map((r) => r[key]), color: colors.baseline },
                { label: 'preflight-conflict', values: gptReviewRuns.preflight.map((r) => r[key]), color: colors.preflight },
              ]}
            />
          ))}
        </div>
        <Reveal className="mt-6">
          <div className="card flex flex-wrap items-center gap-6 p-6">
            <div className="text-5xl font-semibold tabular-nums text-signal">1 / 70</div>
            <p className="max-w-xl text-sm leading-relaxed text-ink-200">
              Chance that all four preflight-conflict runs land below all four baseline runs if the two engines were the same
              (exact rank test, ≈ 1.4 %). Holds for requests and for cache read. One snapshot, so it says nothing yet about other data.
            </p>
          </div>
        </Reveal>
        <SampleNote>gpt-6.1-sol via openai-chatgpt · Review stage · 4 runs per engine · conflict-revision alone was not repeated on GPT · not comparable with the Sonnet numbers above</SampleNote>
      </Section>

      <Section
        id="fullrun"
        eyebrow="05 · Full run · GPT"
        title={<>Across a whole evaluation: −30% requests.</>}
        lead={<>Discover, Maintain, Deepen and Review over three phases of captures. Every agent, every cycle.</>}
      >
        <div className="grid gap-4 md:grid-cols-4">
          <Stat value={`${pct(gptFullRun.baseline.requests, gptFullRun.preflight.requests)}`} label={`requests · ${gptFullRun.baseline.requests} → ${gptFullRun.preflight.requests}`} />
          <Stat value={`${pct(gptFullRun.baseline.seconds, gptFullRun.preflight.seconds)}`} label={`runtime · ${Math.round(gptFullRun.baseline.seconds)} → ${Math.round(gptFullRun.preflight.seconds)} s`} />
          <Stat value={`${pct(gptFullRun.baseline.cacheRead, gptFullRun.preflight.cacheRead)}`} label={`cache read · ${fmtK(gptFullRun.baseline.cacheRead)} → ${fmtK(gptFullRun.preflight.cacheRead)}`} />
          <Stat value={`${gptFullRun.baseline.rejected} → ${gptFullRun.preflight.rejected}`} label="refused workspace calls" />
        </div>
        <Reveal className="mt-6">
          <div className="card p-6">
            <div className="mb-5 flex items-baseline justify-between">
              <span className="text-sm font-medium text-ink-50">Requests per phase</span>
              <span className="rounded-full bg-signal/15 px-2 py-0.5 font-mono text-[10px] text-signal">14/14 checks · both</span>
            </div>
            <div className="grid grid-cols-3 gap-6">
              {[0, 1, 2].map((p) => {
                const b = gptFullRun.baseline.phases[p].requests
                const q = gptFullRun.preflight.phases[p].requests
                return (
                  <div key={p}>
                    <div className="flex h-48 items-end justify-center gap-3">
                      {[
                        [b, colors.baseline],
                        [q, colors.preflight],
                      ].map(([v, c], i) => (
                        <div key={i} className="flex w-14 flex-col items-center justify-end">
                          <span className="mb-1 font-semibold tabular-nums text-ink-50">{v}</span>
                          <motion.div
                            className="w-full rounded-t-md"
                            style={{ background: c as string }}
                            initial={{ height: 0 }}
                            whileInView={{ height: `${((v as number) / 120) * 160}px` }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.8, delay: p * 0.15 + i * 0.1 }}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 text-center font-mono text-[11px] text-ink-300">
                      phase {p + 1} · <span className={q < b ? 'text-signal' : 'text-ink-300'}>{pct(b, q)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </Reveal>
        <SampleNote>gpt-6.1-sol · receipts suite, 3 phases · 1 run per engine · baseline = clearer-rejection · Sonnet full runs in progress</SampleNote>
      </Section>

      <Section
        id="stages"
        eyebrow="06 · Every stage · Sonnet"
        title={<>The gain is where the patch is.</>}
        lead={<>Each stage replayed from the same snapshot. Discover and Maintain don't move — expected, the patch targets Review.</>}
      >
        <div className="overflow-hidden rounded-2xl border border-ink-700">
          <div className="grid grid-cols-[1.2fr_repeat(5,1fr)] bg-ink-850 px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-300">
            <span>Stage</span><span>Checks</span><span>Requests</span><span>Runtime</span><span>Refused</span><span>Cache read</span>
          </div>
          {sonnetStages.map((st, i) => (
            <Reveal key={st.stage} delay={i * 0.06}>
              <div className={`border-t border-ink-700 px-5 py-4 ${st.stage.includes('Review') ? 'bg-signal/[0.04]' : ''}`}>
                {(['b', 'p'] as const).map((k) => {
                  const r = st[k]
                  const o = st[k === 'b' ? 'p' : 'b']
                  const better = (a: number, c: number) => (k === 'p' && a < c ? 'text-signal' : k === 'p' && a > c ? 'text-cost' : 'text-ink-50')
                  return (
                    <div key={k} className="grid grid-cols-[1.2fr_repeat(5,1fr)] items-center py-1 text-sm tabular-nums">
                      <span className="font-mono text-[12px]">
                        {k === 'b' ? <span className="text-ink-50">{st.stage}</span> : null}
                        <span className="ml-2" style={{ color: k === 'b' ? colors.baseline : colors.preflight }}>{k === 'b' ? 'baseline' : 'preflight-conflict'}</span>
                      </span>
                      <span className={r.checks !== o.checks && k === 'p' ? 'text-cost' : 'text-ink-50'}>{r.checks}</span>
                      <span className={better(r.requests, o.requests)}>{r.requests}</span>
                      <span className={better(r.seconds, o.seconds)}>{r.seconds} s</span>
                      <span className={better(r.rejected, o.rejected)}>{r.rejected}</span>
                      <span className={better(r.cacheRead, o.cacheRead)}>{fmtK(r.cacheRead)}</span>
                    </div>
                  )
                })}
                {st.note && <div className="mt-2 font-mono text-[11px] text-ink-300">↳ {st.note}</div>}
              </div>
            </Reveal>
          ))}
        </div>
        <SampleNote>claude-sonnet-5 · 1 run per stage and engine · checks per stage only cover what that stage can affect</SampleNote>
      </Section>

      <footer className="border-t border-ink-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-10">
          <div className="text-2xl font-semibold tracking-tight">
            PipeOps. <span className="text-signal">Prove it before you ship it.</span>
          </div>
          <div className="max-w-md font-mono text-[11px] leading-relaxed text-ink-300">
            Sonnet and GPT numbers are never mixed. Stage runs and full runs are never mixed. Small samples are labeled as such.
          </div>
        </div>
      </footer>
    </div>
  )
}
