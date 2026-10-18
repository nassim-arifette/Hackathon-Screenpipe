import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import mockJson from '../data/mock-experiment.json';
import type { DataOrigin } from '../data/load';
import type { RawExperimentBundle } from '../data/schema';
import {
  deleteSuite,
  fetchDemoRuns,
  fetchLiveExperiment,
  fetchRuns,
  fetchSuiteSpec,
  fetchSuites,
  fetchVariants,
  saveSuite,
  streamWfevalRun,
  type RunSummary,
  type SuiteSummary,
  type VariantSummary,
} from '../data/live';
import { Eyebrow, GhostButton, PrimaryButton, Select } from '../components/ui';

const mock = mockJson as RawExperimentBundle;

/**
 * The run a card is compared against. A variant pairs with the newest baseline of identical
 * test conditions (suite, seed, phases, data); a baseline pairs with the newest variant. Runs
 * of other conditions never pair, so a Step 04 comparison is always like for like.
 */
function partnerOf(r: RunSummary, runs: RunSummary[]): RunSummary | undefined {
  const rivals = runs.filter((x) => x.id !== r.id && x.variant !== r.variant && x.conditions === r.conditions);
  const baselines = rivals.filter((x) => x.variant === 'baseline');
  const pool = r.variant === 'baseline' || baselines.length === 0 ? rivals : baselines;
  return [...pool].sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0];
}

/** "r5" from a run id ending in -r5. */
const replicateOf = (id: string) => id.match(/-(r\d+)$/)?.[1];

/**
 * Step 01 — the only place an experiment gets chosen or produced. Deliberately shows
 * no quality score, request count or runtime: those belong to later steps. Two real
 * paths, both backed by the pipeops server (server/index.mjs):
 *   A. load a run already sitting in eval/runs/ — a file read, no cost.
 *   B. trigger a real wfeval run — a real model-calling cycle, gated by confirmation.
 * If the server itself isn't reachable, that's shown plainly; falling back to the mock
 * placeholder is an explicit choice here, never a silent default.
 */
export function LoadView({
  onLoad,
  currentRunId,
}: {
  onLoad: (bundle: RawExperimentBundle, runId: string, origin: DataOrigin) => void;
  currentRunId?: string;
}) {
  const [source, setSource] = useState<'demo' | 'local'>('demo');
  const [localRuns, setLocalRuns] = useState<RunSummary[] | null>(null);
  const [demoRuns, setDemoRuns] = useState<RunSummary[] | null>(null);
  const runs = source === 'demo' ? demoRuns : localRuns;
  const [variants, setVariants] = useState<VariantSummary[] | null>(null);
  const [suites, setSuites] = useState<SuiteSummary[]>([]);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState('');
  const [form, setForm] = useState({ variant: '', suite: 'receipts', seed: 1, phases: 1 });
  const logRef = useRef<HTMLDivElement>(null);

  const refresh = () => {
    setBackendError(null);
    fetchRuns()
      .then(setLocalRuns)
      .catch((e: Error) => setBackendError(e.message));
    fetchDemoRuns()
      .then(setDemoRuns)
      .catch((e: Error) => setBackendError(e.message));
    fetchSuites()
      .then(setSuites)
      .catch(() => {
        /* like variants: a convenience for the run form; the runs list carries the real error */
      });
    fetchVariants()
      .then((v) => {
        setVariants(v);
        setForm((f) => (f.variant ? f : { ...f, variant: v[0]?.file ?? '' }));
      })
      .catch(() => {
        /* variants list is a convenience for the run form; runs list carries the real error */
      });
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const loadRecorded = async (id: string) => {
    setLoadingId(id);
    try {
      // Pair with the most recent run of a different variant, so Compare Variants (Step
      // 04) has something real to compare against instead of the run against itself.
      // Only runs with identical test conditions (suite, seed, phases, data) qualify.
      const picked = runs?.find((r) => r.id === id);
      const partner = picked && runs ? partnerOf(picked, runs) : undefined;
      // Whichever of the two is actually named "baseline" takes the baseline slot,
      // regardless of which one was clicked.
      const [baselineId, variantId] =
        partner?.variant === 'baseline' && picked?.variant !== 'baseline' ? [partner.id, id] : [id, partner?.id];
      const bundle = await fetchLiveExperiment(baselineId, variantId, source);
      onLoad(bundle, id, source === 'demo' ? 'demo' : 'recorded');
    } catch (e) {
      setBackendError((e as Error).message);
    } finally {
      setLoadingId(null);
    }
  };

  const loadMock = () => onLoad(mock, mock.comparison.baseline, 'mock');

  const startRun = async () => {
    setConfirming(false);
    setRunning(true);
    setLog('');
    let newId: string | null = null;
    try {
      await streamWfevalRun(form, (chunk) => {
        setLog((l) => l + chunk);
        const m = chunk.match(/run complete: (\S+)/);
        if (m) newId = m[1];
      });
      if (newId) {
        const bundle = await fetchLiveExperiment(newId);
        onLoad(bundle, newId, 'live');
      } else {
        refresh();
      }
    } catch (e) {
      setLog((l) => l + `\n[pipeops] ${(e as Error).message}\n`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto px-[120px] py-[72px]">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
        <h1 className="text-[76px] font-semibold leading-[1.02] tracking-tightest text-ink-50">
          Select or run an experiment.
        </h1>
        <p className="mt-5 max-w-[1040px] text-[21px] leading-relaxed text-ink-300">
          See how Screenpipe's agents turn recorded activity into workflows.{' '}
          <span className="text-ink-100">Browsing is free.</span>
        </p>
      </motion.div>

      {backendError && (
        <div className="mt-8 rounded-2xl border border-cost/40 bg-cost/[0.06] p-5">
          <div className="text-[18px] font-medium text-cost">pipeops server not reachable</div>
          <p className="mt-1.5 text-[16px] leading-relaxed text-ink-300">
            {backendError} — start it with <code className="rounded bg-ink-900 px-1.5 py-0.5 font-mono">npm run server</code> inside{' '}
            <code className="rounded bg-ink-900 px-1.5 py-0.5 font-mono">pipeops/</code>, then retry. The app will not quietly show
            placeholder data instead — you choose.
          </p>
          <div className="mt-3 flex gap-2">
            <GhostButton size="lg" onClick={refresh}>Retry</GhostButton>
            <GhostButton size="lg" onClick={loadMock}>Continue with mock placeholder</GhostButton>
          </div>
        </div>
      )}

      <div className="mt-12 grid min-h-0 flex-1 grid-cols-2 gap-14">
        {/* A — explore recorded runs */}
        <section className="flex min-h-0 flex-col">
          <div className="flex items-center justify-between">
            <Eyebrow size="xl">A · Explore recorded runs</Eyebrow>
            <GhostButton size="lg" onClick={refresh}>refresh</GhostButton>
          </div>
          <div className="mt-4 flex gap-2">
            {(['demo', 'local'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSource(s)}
                className={`rounded-full border px-5 py-2 font-mono text-[14px] uppercase tracking-[0.12em] transition-colors ${
                  source === s ? 'border-signal/70 text-signal' : 'border-ink-700 text-ink-400 hover:border-ink-500'
                }`}
              >
                {s === 'demo' ? 'Demo runs' : 'Local runs'}
              </button>
            ))}
          </div>
          <div className="mt-5 flex-1 space-y-3 overflow-y-auto pr-2">
            {runs === null && !backendError && <p className="font-mono text-[16px] text-ink-400">loading runs…</p>}
            {runs?.length === 0 && source === 'local' && <p className="text-[17px] text-ink-400">No completed runs in eval/runs/ yet. Run one on the right.</p>}
            {runs?.length === 0 && source === 'demo' && <p className="text-[17px] text-ink-400">No demo runs in pipeops/demo-data/ yet. See demo-data/CONTRIBUTING.md.</p>}
            {runs
              // A baseline that some variant is compared against is shown on that variant's card, not twice.
              ?.filter((r) => r.variant !== 'baseline' || !runs.some((x) => x.variant !== 'baseline' && partnerOf(x, runs)?.id === r.id))
              .map((r) => {
                const partner = partnerOf(r, runs);
                const pairedWith = partner ? [partner.variant ?? partner.id, replicateOf(partner.id)].filter(Boolean).join(' ') : undefined;
                return (
                  <RunCard key={r.id} r={r} pairedWith={pairedWith} active={r.id === currentRunId} loading={loadingId === r.id} onClick={() => loadRecorded(r.id)} />
                );
              })}
          </div>
        </section>

        {/* B — run a new experiment */}
        <section className="flex min-h-0 flex-col border-l border-ink-800 pl-14">
          <Eyebrow size="xl">B · Run new experiment</Eyebrow>
          <p className="mt-3 text-[19px] leading-relaxed text-ink-400">
            Runs the real agents here: 8–15 min per phase, uses AI allowance. Quit the screenpipe app first.
          </p>

          <div className="mt-7 flex flex-col gap-4">
            <Labeled size="xl" label="variant">
              <Select
                value={form.variant}
                onChange={(v) => setForm((f) => ({ ...f, variant: v }))}
                options={(variants ?? []).map((v) => ({ value: v.file, label: v.name }))}
                disabled={running}
                placeholder="choose a variant"
                size="xl"
              />
            </Labeled>
            <div className="flex gap-3">
              <Labeled size="xl" label="suite">
                <Select
                  value={form.suite}
                  onChange={(v) => setForm((f) => ({ ...f, suite: v }))}
                  options={(suites.length ? suites : [{ name: form.suite, description: '' }]).map((x) => ({ value: x.name, label: x.name }))}
                  disabled={running}
                  size="xl"
                />
              </Labeled>
              <Labeled size="xl" label="seed">
                <input
                  type="number"
                  className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3.5 py-3 font-mono text-[19px] text-ink-100"
                  value={form.seed}
                  onChange={(e) => setForm((f) => ({ ...f, seed: Number(e.target.value) }))}
                  disabled={running}
                />
              </Labeled>
              <Labeled size="xl" label="phases">
                <input
                  type="number"
                  className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3.5 py-3 font-mono text-[19px] text-ink-100"
                  value={form.phases}
                  onChange={(e) => setForm((f) => ({ ...f, phases: Number(e.target.value) }))}
                  disabled={running}
                />
              </Labeled>
            </div>

            <CustomSuites suites={suites} onChange={refresh} onUse={(name) => setForm((f) => ({ ...f, suite: name }))} disabled={running} />

            {!confirming ? (
              <PrimaryButton size="xl" className="self-start" onClick={() => setConfirming(true)} disabled={running || !form.variant}>
                {running ? 'Running…' : 'Run new experiment'}
              </PrimaryButton>
            ) : (
              <div className="flex items-center gap-3 rounded-xl border border-cost/40 bg-cost/[0.06] p-3">
                <span className="text-[17px] leading-snug text-cost">
                  Uses real AI allowance and takes several minutes. Continue?
                </span>
                <PrimaryButton size="xl" className="shrink-0" onClick={startRun}>
                  Confirm
                </PrimaryButton>
                <GhostButton size="xl" className="shrink-0" onClick={() => setConfirming(false)}>
                  Cancel
                </GhostButton>
              </div>
            )}
          </div>

          {log && (
            <div ref={logRef} className="mt-5 h-44 overflow-y-auto rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-[15px] text-ink-300">
              <pre className="whitespace-pre-wrap">{log}</pre>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Developer-written test suites, collapsed by default. A suite is a JSON file (the format is
 * documented at the top of eval/src/wfeval/custom.py) saved to eval/suites/; the harness
 * renders and validates it on save, so a suite that can't be run is never listed.
 */
function CustomSuites({
  suites,
  onChange,
  onUse,
  disabled,
}: {
  suites: SuiteSummary[];
  onChange: () => void;
  onUse: (name: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const custom = suites.filter((s) => !s.builtin);

  const edit = async (n: string) => {
    try {
      setName(n);
      setText(JSON.stringify(await fetchSuiteSpec(n), null, 2));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const save = async () => {
    let spec: unknown;
    try {
      spec = JSON.parse(text);
    } catch (e) {
      setError(`Not valid JSON: ${(e as Error).message}`);
      return;
    }
    setSaving(true);
    try {
      await saveSuite(name.trim(), spec);
      setError(null);
      onChange();
      onUse(name.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (n: string) => {
    await deleteSuite(n).catch((e: Error) => setError(e.message));
    onChange();
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setText(await file.text());
    if (!name) setName(file.name.replace(/\.json$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-'));
    setError(null);
  };

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900/60">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3.5 text-left"
        aria-expanded={open}
      >
        <span className="font-mono text-[15px] uppercase tracking-widest text-ink-400">Custom test suites</span>
        <span className="flex items-center gap-3 text-[17px] text-ink-400">
          {custom.length} yours
          <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-ink-800 px-4 pb-4 pt-3">
          <p className="text-[17px] leading-snug text-ink-400">
            Your own test: hidden jobs, how they look on screen, and the checks. Pick it in <span className="text-ink-200">suite</span> above.
          </p>

          {custom.length > 0 && (
            <ul className="space-y-1.5">
              {custom.map((s) => (
                <li key={s.name} className="flex items-center justify-between gap-3 rounded-lg bg-ink-950/60 px-3 py-2 text-[17px] text-ink-200">
                  <span className="min-w-0 truncate font-mono">
                    {s.name}
                    <span className="text-ink-400">{s.broken ? ' · unreadable' : ` · ${s.jobs} jobs · ${s.checks} checks`}</span>
                  </span>
                  <span className="flex shrink-0 gap-3 text-ink-400">
                    <button className="hover:text-signal" onClick={() => edit(s.name)}>edit</button>
                    <button className="hover:text-cost disabled:opacity-40" disabled={disabled} onClick={() => remove(s.name)}>remove</button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[15px] uppercase tracking-widest text-ink-400">suite name</span>
            <input
              className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3.5 py-3 font-mono text-[19px] text-ink-100"
              value={name}
              placeholder="my-suite"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[15px] uppercase tracking-widest text-ink-400">suite definition (JSON)</span>
            <textarea
              className="h-48 w-full resize-y rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-[16px] leading-snug text-ink-100"
              value={text}
              spellCheck={false}
              placeholder='{"jobs": {…}, "phases": {"1": […]}, "checks": […]}'
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {error && <pre className="whitespace-pre-wrap rounded-lg border border-cost/40 bg-cost/[0.06] p-3 font-mono text-[16px] text-cost">{error}</pre>}
          <div className="flex flex-wrap items-center gap-2">
            <PrimaryButton size="xl" onClick={save} disabled={saving || !name.trim() || !text.trim()}>
              {saving ? 'Checking…' : 'Save suite'}
            </PrimaryButton>
            {suites.some((s) => s.name === 'standup') && (
              <GhostButton size="xl" onClick={() => edit('standup').then(() => setName(''))}>Start from example</GhostButton>
            )}
            <label className="cursor-pointer rounded-full border border-ink-700 px-5 py-2.5 text-[18px] text-ink-300 hover:border-ink-500">
              Upload .json
              <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

function Labeled({ label, children, size = 'lg' }: { label: string; children: React.ReactNode; size?: 'lg' | 'xl' }) {
  return (
    <label className="flex flex-1 flex-col gap-2">
      <span className={`font-mono ${size === 'xl' ? 'text-[15px]' : 'text-[13px]'} uppercase tracking-widest text-ink-400`}>{label}</span>
      {children}
    </label>
  );
}

/** Metadata only — no score, requests or runtime. Those are revealed inside the lab. */
function RunCard({ r, pairedWith, active, loading, onClick }: { r: RunSummary; pairedWith?: string; active: boolean; loading: boolean; onClick: () => void }) {
  const when = r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '—';
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`group flex w-full items-center justify-between rounded-2xl border px-7 py-6 text-left transition-colors ${
        active ? 'border-signal/70 bg-ink-900' : 'border-ink-700 bg-ink-900/60 hover:border-ink-500'
      }`}
    >
      <div>
        <div className="flex items-center gap-3">
          <span className="text-[28px] font-semibold tracking-tight text-ink-50">{r.variant ?? r.id}</span>
          <span className="rounded-full border border-ink-600 px-2.5 py-0.5 font-mono text-[12.5px] uppercase tracking-[0.12em] text-ink-300">
            complete
          </span>
        </div>
        <div className="mt-2 font-mono text-[15px] text-ink-400">
          suite {r.suite ?? '—'} · seed {r.seed ?? '—'} · phase{r.phases.length > 1 ? 's' : ''} {r.phases.join(', ')}
        </div>
        {pairedWith && <div className="mt-1 text-[15.5px] text-ink-300">compared with {pairedWith}</div>}
        <div className="mt-1 font-mono text-[13.5px] text-ink-500">finished {when}</div>
      </div>
      <span className={`text-[16px] font-medium ${loading ? 'text-signal' : 'text-ink-300 group-hover:text-signal'}`}>
        {loading ? 'Loading…' : 'Load →'}
      </span>
    </button>
  );
}
