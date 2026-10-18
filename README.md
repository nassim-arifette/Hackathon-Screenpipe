# PipeOps: Prove It Before You Ship It

> **Did your agent discover the right workflows? And how efficiently did it do so?**

**Team PipeOps** · Hackathon · Build Agents That Remember · Track 01, *Find what to automate*

**Live demo:** [pipeops-zeta.vercel.app](https://pipeops-zeta.vercel.app), hosted on Vercel and redeployed automatically from `main`. It is read-only and shows the bundled demo runs (`pipeops/demo-data/`); local runs, Stage Replay and live wfeval runs need the local setup ([`pipeops/README.md`](pipeops/README.md)).

Screenpipe Workflows discovers repeatable tasks from recorded activity. When a developer changes one of
its agents, how can they know the change helped?

**PipeOps is an evaluation workbench for Screenpipe Workflows.** It runs the real Workflows agents against
controlled activity histories with known answers and measures two things:

- **Quality:** did the agents find the right tasks, keep the important exceptions, filter out noise, and
  cite valid evidence?
- **Efficiency:** how many model requests and how much runtime (token usage is recorded too) did it take?

Developers can inspect results, compare variants and replay a single agent stage. **PipeOps gives Screenpipe
developers the evidence to measure workflow quality, diagnose inefficient agent behavior, and validate
improvements before release.** We used it on Workflows itself, and it found an inefficiency, validated a fix,
and exposed blind spots in the evaluation (below).

![Agent Execution: what Screenpipe actually produced](docs/screenshots/light-agent-execution.png)

## What we found

Receipts suite, seed 1, Claude Sonnet 5. The full log, with every run, is in
[`eval/EXPERIMENTS.md`](eval/EXPERIMENTS.md).

**1. Not every change is an improvement.** Our `episode-routing` variant passed the same 11/11 checks as
the baseline but used 111 model requests instead of 89 and 1175 s instead of 650 s (full cycle, one run
each). **Result: no improvement demonstrated.**

**2. Clearer rejection feedback cut the Review agent's retries.** Reading the runs with `wfeval why-rejected`
showed that Review's publishes were rejected because items cited captures missing from the stage's
evidence, and the engine's error never said which or why, so Review retried or dropped items. The
`clearer-rejection` engine variant (applied on top of `second-precision`, which fixes whole-second
citation matching) names each failing item and the reason. On the Review stage, from the same saved state:

| | Baseline (2 runs) | Clearer-rejection (3 runs) |
|---|---:|---:|
| Model requests | 38–56 | **18–19** |
| Runtime | 387–472 s | **131–152 s** |
| Output tokens | 43–49k | **13–14k** |
| Catalog checks | 11/11 | **11/11** |

**Result: fewer requests and less runtime while passing all 11 existing checks.** These are stage-level
runs, not proof of an end-to-end improvement, and removing `second-precision` raised the median back to 26 requests,
so the two changes work together.

**3. The evaluation has blind spots, and finding them is part of the job.** Two examples:

- A stale ground-truth spelling made the `missing_date` check look failed in 10 of 15 Review runs. The
  workflows were right and the grader was wrong; regraded, all 15 pass, and the harness now flags a stale truth.
- The engine silently cut every workflow description at 400 characters (open questions and limitations at 180).
  Every run lost 6 to 12 fields, one description stopped mid-word, and all 11 checks still passed. The harness
  now reports this as `clipped`, and the `full-text` variant loses none (3 runs, no measurable cost to Review).
  Whether keeping the full text improves later cycles has not been measured.

**Result: passing every check does not mean every aspect of workflow quality is correct.**

## Quick start: run the demo (no accounts, no model calls)

Requires Node 18+ (tested on Node 20).

```sh
git clone https://github.com/MylittleQueercat/Hackathon-Screenpipe.git
cd Hackathon-Screenpipe/pipeops
npm install

npm run server     # terminal 1: data bridge on http://127.0.0.1:8787
npm run dev        # terminal 2: the UI on http://localhost:5173
```

Open <http://localhost:5173>. Nothing here calls a model: the app only reads recorded results.

### Reproduce the demo

1. **Enter the Lab.** At **Step 01** keep **Demo runs** selected and load `episode-routing`. It
   is paired automatically with `baseline`, which saw exactly the same data.
2. **Step 02, Agent execution.** Watch the pipeline Discover → Maintain → Deepen → Review with
   the real request count and agent time per stage. Click a stage for the agent's own summary, or a
   workflow chip to read its trigger, outcome, steps, variations, limitations and confidence.
3. **Step 03, Inspect evaluation.** Step through the 11 checks. Each one shows the expected result, the
   actual result and the evidence the run recorded for it.
4. **Step 04, Compare variants.** Press **Run reveal**: the same checks pass, but there are more requests
   and a longer runtime, so the verdict is *no improvement demonstrated*. We report that as it is.
5. **Step 05, Stage replay.** Pick a stage and press **Preview Replay Plan** (a simulation, no model
   calls). Running it for real is a separate button that needs a saved snapshot, a built engine and an
   explicit confirmation, and it spends AI allowance.

Keyboard: `←` `→` or `1`–`5` move between steps, `space` plays the current step, and the corner
button switches dark and light.

| | |
|---|---|
| ![Inspect evaluation](docs/screenshots/light-evidence.png) | ![Compare variants](docs/screenshots/light-compare.png) |
| ![Load experiment](docs/screenshots/light-load.png) | ![Stage replay](docs/screenshots/light-stage-replay.png) |

## How screenpipe is used

Without screenpipe's memory there would be nothing to evaluate; the whole project is built
on top of it.

- **The real engine.** The harness builds screenpipe at a pinned commit (`a8aaee2d`) plus a
  small patch (`eval/patches/harness.patch`) that adds one route, `/eval/seed`, enabled only
  in eval mode. Nothing in the Workflows code is replaced.
- **Recorded history, seeded.** A deterministic generator writes a synthetic week of work
  (frames with accessibility text, UI events, app and window names, timestamps) into the engine
  in the same form screen capture would. The agents therefore read what they would read from a
  real recording, but there is no real user data in this repo.
- **The shipped agents.** Four Workflows agents (`workflow-discover`, `-maintain`, `-deepen`,
  `-review`) run against that history through screenpipe's own API (`/workflows/workspace`,
  `/activity-summary`, `/search`, `/frames`, `/meetings`). We measure them; we don't reimplement them.
- **The catalog it writes.** Each published workflow carries a trigger, an outcome, steps,
  variations, limitations, a confidence rating and cited evidence (`timestamp`, `app`). The
  harness checks that evidence resolves to real captured frames and that the right jobs were found,
  the one-offs were not, noise was ignored, and a changed naming rule updated the existing workflow.
- **Isolated by design.** Runs use their own data dir and port, tools run in a container with no
  network, and your real screenpipe history is never read.

## What's in this repo

| Part | What it is |
|---|---|
| [`eval/`](eval/README.md) | **`wfeval`**, the evaluation harness. Seeds a synthetic history into a real screenpipe engine, runs the shipped Workflows agents, and grades the workflows they publish against hidden ground truth. Also runs one agent alone from a saved state ("stage runs") and compares variants. Engine variants and what each measured are in `eval/variants/` and `eval/EXPERIMENTS.md`. |
| [`pipeops/`](pipeops/README.md) | **PipeOps**, the web workbench (React + TypeScript, small Express bridge, dark and light themes). Load an experiment, see what each agent did, inspect every check, compare two variants, replay a stage. Includes the export and validate scripts and its offline tests. |
| [`pipeops/demo-data/`](pipeops/demo-data/CONTRIBUTING.md) | Real, sanitized experiment results in a portable JSON format, so the demo runs on any laptop with no screenpipe account. Also holds `CONTRIBUTING.md`. |

## Run the tests (offline, no model calls)

```sh
cd pipeops && npm run typecheck && npm test            # exporter, validator, API safety, comparability
cd eval && uv run --group dev pytest -q                # generator, grader, negative controls, sandbox
```

If `uv run` fails with `No module named 'wfeval'` on macOS, run it as
`PYTHONPATH=src uv run …` (details in [`pipeops/README.md`](pipeops/README.md#troubleshooting)).

## Run a real evaluation (optional, spends AI allowance)

This needs an Apple Silicon Mac with the screenpipe desktop app (quit while running), a screenpipe
account with Workflows, Rust, `uv` and Docker. Setup and commands are in
[`eval/README.md`](eval/README.md). From PipeOps, Step 01 → *Run new experiment* starts a real run
behind a confirmation. A full cycle takes roughly 8–15 minutes per phase.

## Share your own experiment

Every `*.json` in [`pipeops/demo-data/`](pipeops/demo-data/) that passes validation appears under
**Demo runs** automatically.

```sh
cd pipeops
npm run export-run -- <runId>      # eval/runs/<runId> -> demo-data/<runId>.json
npm run validate-demo
```

Exports are allowlisted (metrics, checks, workflows, provenance hashes), exclude logs, prompts and
credentials, scan for secrets and host paths, and are refused if invalid. Two runs are only compared
when they share suite, seed, phases and data hashes, and stage results are never shown as full-evaluation
scores. See [`CONTRIBUTING.md`](pipeops/demo-data/CONTRIBUTING.md).
