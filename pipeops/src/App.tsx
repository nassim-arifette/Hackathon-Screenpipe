import { motion } from 'framer-motion';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { normalize, type DataOrigin } from './data/load';
import type { Experiment, RawExperimentBundle, StageId } from './data/schema';
import { Header } from './components/Header';
import { StepRail, STEPS } from './components/StepRail';
import { LoadView } from './views/LoadView';
import { CanvasView } from './views/CanvasView';
import { EvidenceView } from './views/EvidenceView';
import { CompareView } from './views/CompareView';
import { ReplayView } from './views/ReplayView';
import { Landing } from './views/Landing';
import { PLAY_EVENT } from './lib/events';
import { applyTheme, useTheme } from './lib/theme';

const W = 1920;
const H = 1080;

/** Fixed 1920×1080 design surface, scaled to fit any window (stable for screen recording). */
function useFitScale() {
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / W, window.innerHeight / H));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return scale;
}

/** The fixed design-surface shell every screen (landing, load, workspace) renders inside,
 *  so the whole app records at a stable 1920×1080 regardless of window size. */
function ThemeToggle() {
  const theme = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      onClick={() => applyTheme(next)}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
      className="absolute right-10 top-[22px] z-50 flex h-7 w-7 items-center justify-center rounded-full border border-ink-700 bg-ink-900 text-ink-300 transition hover:border-ink-500 hover:text-ink-50"
    >
      {theme === 'dark' ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}

function Stage({ scale, children }: { scale: number; children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-ink-950">
      <div
        className="lab-bg relative flex shrink-0 flex-col overflow-hidden"
        style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: 'center' }}
      >
        <ThemeToggle />
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const scale = useFitScale();
  const [entered, setEntered] = useState(false);
  const [data, setData] = useState<Experiment | null>(null);
  const [origin, setOrigin] = useState<DataOrigin | null>(null);
  const [step, setStep] = useState(0);
  const [runId, setRunId] = useState<string | null>(null);
  const [replayStage, setReplayStage] = useState<StageId | null>(null);

  const loaded = runId !== null;

  /** Step 01 calls this once an experiment is picked (a recorded run) or produced
   *  (a just-finished live run) — nothing before this point touches real data. */
  const handleLoad = useCallback((bundle: RawExperimentBundle, selectedRunId: string, loadOrigin: DataOrigin) => {
    setData(normalize(bundle));
    setOrigin(loadOrigin);
    setRunId(selectedRunId);
    setReplayStage(null);
    setStep(1);
  }, []);

  const go = useCallback(
    (next: number) => {
      if (!data) return;
      setStep(Math.max(0, Math.min(STEPS.length - 1, next)));
    },
    [data],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowRight') go(step + 1);
      else if (e.key === 'ArrowLeft') go(step - 1);
      else if (/^[1-5]$/.test(e.key)) go(Number(e.key) - 1);
      else if (e.key === ' ') {
        e.preventDefault();
        window.dispatchEvent(new Event(PLAY_EVENT));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, step]);

  if (!entered) {
    return (
      <Stage scale={scale}>
        <Landing onEnter={() => setEntered(true)} />
      </Stage>
    );
  }

  // Nothing is loaded yet: step 01 owns the whole screen (no Header/StepRail chrome,
  // no result of any kind) until the user picks or runs an experiment.
  if (!data) {
    return (
      <Stage scale={scale}>
        <LoadView onLoad={handleLoad} />
      </Stage>
    );
  }

  const run = data.runs.find((r) => r.id === runId) ?? data.runs[0];

  return (
    <Stage scale={scale}>
      <Header experiment={data} origin={origin} runs={data.runs} activeRunId={loaded ? run.id : null} onRun={(id) => setRunId(id)} step={step} />
      <main className="relative min-h-0 flex-1">
        {/* Enter-only transition: views mount fresh and fade in (no exit wait, nothing can get stuck). */}
        <motion.div
          key={STEPS[step].key}
          className="absolute inset-0"
          initial={{ opacity: 0, y: 14, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        >
          {step === 0 && <LoadView onLoad={handleLoad} currentRunId={run.id} />}
          {step === 1 && (
            <CanvasView
              experiment={data}
              run={run}
              onOpenEvidence={() => go(2)}
              onReplayStage={(s) => {
                setReplayStage(s);
                go(4);
              }}
            />
          )}
          {step === 2 && <EvidenceView experiment={data} run={run} />}
          {step === 3 && <CompareView experiment={data} />}
          {step === 4 && <ReplayView experiment={data} run={run} stage={replayStage} onStage={setReplayStage} />}
        </motion.div>
      </main>
      <StepRail step={step} loaded={loaded} onStep={go} />
    </Stage>
  );
}
