# PipeOps · Review candidates

A standalone page comparing three engines for the Screenpipe Workflows Review agent: `clearer-rejection` (baseline), `conflict-revision` and `preflight-conflict`. It covers their architectures, a request-by-request replay of the Sonnet Review runs, and the Sonnet and GPT measurements.

```bash
cd candidates-site
npm install
npm run dev      # http://localhost:5173
npm run build    # static output in dist/
```

Data lives in `src/data.ts` and `src/data/timelines.json`. The timelines were extracted from the `requests.jsonl` logs of the Sonnet Review stage runs (snapshot `20261017T145651Z-baseline-receipts-s1`, step `04-p1-workflow-review`).
