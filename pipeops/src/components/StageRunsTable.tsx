import type { StageRegrades, StageRun, VariantSummary } from '../data/live';
import { fmtCount } from '../lib/efficiency';
import { Eyebrow, GhostButton } from './ui';

/** Checks as graded against the suite's current truth where that was possible, else as the run's own files say. */
export function checksText(r: StageRun, regrades?: StageRegrades | null): string | null {
  const now = regrades?.[r.id];
  if (now) return `${now.passed}/${now.scored}`;
  return r.checksPassed === null || r.checksScored === null ? null : `${r.checksPassed}/${r.checksScored}`;
}

const listOf = (xs: (string | null)[]) => xs.map((x) => x ?? '—').join(' · ');

/**
 * Stage runs recorded by `wfeval stage`, one row per variant, every run listed (there are only 1 to 3
 * each, so no averages). They start from one saved snapshot and run only this stage, so they say how a
 * change behaves on that stage, not how the whole pipeline scores. Runs the harness failed (no request
 * logged) are left out of the rows and counted underneath, never dropped silently. A dash is "not
 * recorded", a recorded zero is "0".
 */
export function StageRunsTable({
  runs,
  variants,
  title,
  regrades,
  onClose,
}: {
  runs: StageRun[];
  variants: VariantSummary[];
  /** e.g. "Review" or "Deepen → Review" */
  title: string;
  regrades?: StageRegrades | null;
  onClose?: () => void;
}) {
  const usable = runs.filter((r) => r.usable);
  const rows = [...new Set(usable.map((r) => r.variant))].map((v) => ({ variant: v, runs: usable.filter((r) => r.variant === v) }));
  const excluded = runs.filter((r) => !r.usable);
  const snapshots = [...new Set(usable.map((r) => r.snapshot).filter(Boolean))];
  const n = (x: number | null) => (x === null ? null : String(x));
  const cols = [
    { head: 'Requests', cell: (r: StageRun) => n(r.requests) },
    { head: 'Agent time', cell: (r: StageRun) => (r.seconds === null ? null : `${r.seconds}s`) },
    { head: 'Output tokens', cell: (r: StageRun) => fmtCount(r.outputTokens) },
    { head: 'Cache read', cell: (r: StageRun) => fmtCount(r.cacheReadTokens) },
    { head: 'Failed calls', cell: (r: StageRun) => n(r.failedCalls) },
    { head: 'Checks', cell: (r: StageRun) => checksText(r, regrades) },
  ];
  return (
    <>
      <div className="flex items-start justify-between">
        <div>
          <Eyebrow>Recorded stage runs · {title} only</Eyebrow>
          <p className="mt-2 text-[16.5px] text-ink-300">
            Each run starts from the same saved snapshot{snapshots.length === 1 ? <span className="font-mono text-ink-400"> ({snapshots[0]})</span> : ''}
            . <span className="text-ink-100">Not comparable to full-evaluation scores.</span>
          </p>
        </div>
        {onClose && <GhostButton onClick={onClose}>Close</GhostButton>}
      </div>
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="font-mono text-[12.5px] uppercase tracking-widest text-ink-400">
              <th className="w-[250px] py-1.5 font-normal">Variant</th>
              {cols.map((c) => (
                <th key={c.head} className="font-normal">
                  {c.head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ variant, runs: rs }) => {
              const desc = variants.find((v) => v.name === variant)?.description ?? null;
              return (
                <tr key={variant} className="border-t border-ink-800 align-top">
                  <td className="py-2 pr-4">
                    <div className="text-[15px] font-medium text-ink-50">
                      {variant} <span className="font-mono text-[13px] font-normal text-ink-400">× {rs.length}</span>
                    </div>
                    {desc && (
                      <div className="mt-0.5 max-w-[240px] truncate text-[13.5px] text-ink-400" title={desc}>
                        {desc}
                      </div>
                    )}
                  </td>
                  {cols.map((c) => (
                    <td key={c.head} className="tnum whitespace-nowrap py-2 pr-6 font-mono text-[15.5px] text-ink-200" title={c.head === 'Failed calls' ? 'null = not logged in older runs' : undefined}>
                      {listOf(rs.map(c.cell))}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[14.5px] leading-snug text-ink-400">
        One value per run, in the order they were recorded. Checks are graded against the current truth (wfeval grade --truth); a run that could not be graded again shows the score in its own files.
        {excluded.length > 0 && (
          <span className="text-cost">
            {' '}
            {excluded.length} run{excluded.length > 1 ? 's' : ''} left out: the harness logged no model request ({[...new Set(excluded.map((r) => r.variant))].join(', ')}).
          </span>
        )}
      </p>
    </>
  );
}
