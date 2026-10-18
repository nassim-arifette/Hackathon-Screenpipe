# Workflows eval harness

Measures what a change to screenpipe's Workflows does, on the same synthetic history,
against the shipped version: which workflows get published, which checks pass, and what
each cycle costs in agent runs and tokens. Reuses the architecture of an earlier
harness, eval-sketch (sandboxed tools, provenance, reruns, paired comparison).

- `DATA.md`: what is seeded and the rules that make a result mean something.
- `MISTAKES.md`: the tags a grade can carry.

## How a run works

1. `generate.py` renders a suite's hidden stories (`stories.py`) into frames,
   deterministically from (suite, seed), and refuses to write a suite whose checks have
   no on-screen evidence or whose screens leak the answer.
2. `run.py` clones a warm template data dir to a fixed slot (`/Users/Shared/wfeval/live`,
   or `live<k>` when that one is busy), starts the **patched engine** there (fresh HOME,
   port 3036, or `3036+k`, on 127.0.0.1, environment built from scratch, all capture off;
   see "Same inputs on every Mac"), installs and
   enables the four workflow pipes, seeds phase 1 through `POST /eval/seed`, and runs a
   cycle the way the desktop's "Update now" does. Phase 2 (a naming rule changes) and
   phase 3 (nothing new) follow on the same engine. The run then moves to `runs/`.
3. Agent tools run in a container (`sandbox/`, `agent/sandbox-tools.ts`): Pi's own
   bash/read/write/edit definitions, executed via `docker exec`, `--network none`. Inside,
   `localhost:3030` and `localhost:3036` are the eval engine, relayed over the exec pipe
   (`sandbox/portal.py`);
   the real screenpipe on the host's 3030 is unreachable. This matters: the curl auth shim
   and the agents assume port 3030, so on the host they would either miss auth or hit your
   real history.
4. `grade.py` attributes each published workflow to a job through its cited evidence,
   then scores the suite's checks. `compare.py` pairs two variants phase by phase.
5. For fast iteration, `stage.py` saves the engine state between agents and reruns one
   agent from a saved state ("Stage runs").

Each run keeps `run.json` (variant, data hashes, engine commit, patch and binary hashes, Pi
version and lockfile, bun version, image id, contamination check, host-path leak scan,
prompt hashes), the catalog, workspace, executions and pipe logs of every phase,
`requests.jsonl` (every model request, its usage, every tool call, and each Workflows
call in full with the engine's reply), `prompts/`, `seeded.jsonl` and `results.jsonl`.
The usage in `results.jsonl` counts Workflows calls by action and failed calls by kind
(`workspace.failures`): the engine logs none of the rejections its agents retry on.

## Needs

- An Apple Silicon Mac with the screenpipe desktop app installed (the harness uses the
  `bun` it ships). **Quit the app while the harness runs**: both use port 3030 and the
  app records your screen.
- A screenpipe account with Workflows (Business) whose tier offers `claude-sonnet-5`.
  The harness logs in its own copy of the data dir; your real one is never touched.
- Rust (`rustup`), `uv`, Docker (OrbStack or Docker Desktop).
- Nix only to rebuild the sandbox image (`sandbox/load.sh --build`, needs an
  `aarch64-linux` builder); otherwise the published image is pulled.

## Setup (once)

```sh
cd eval
./setup-engine.sh          # clones screenpipe at a8aaee2d, applies patches/harness.patch, builds
sandbox/load.sh            # pulls the sandbox image (pinned by digest) into Docker
uv run wfeval template     # warm data dir with Pi and the four workflow pipes
SCREENPIPE_DATA_DIR=$PWD/.engines/template/home/.screenpipe .engines/target/debug/screenpipe login
uv run wfeval check-engine # 15 s, no model calls: does everything above work?
./setup-engine.sh clearer-rejection   # optional: an engine variant from patches/variants/
```

`login` opens a browser; the session lands in the template, and every run copies it.
On a Nix-managed Mac, `cargo` must use Apple's toolchain: run `setup-engine.sh` inside
`nix shell nixpkgs#rustup nixpkgs#pkg-config` with `PATH=/usr/bin:$PATH CC=/usr/bin/cc
CXX=/usr/bin/c++ AR=/usr/bin/ar CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=/usr/bin/cc`.

On Linux (Ubuntu/Debian, x86_64 or arm64), run `./setup-linux.sh` first (sudo): it
installs the engine's build deps, OpenBLAS where the build looks for it, qemu binfmt on
x86_64 (the sandbox image is arm64), the app's `bun` and an `ffmpeg` in `.engines/app`,
and `/Users/Shared/wfeval`, the same run path as on a Mac. The steps above then work
as written; `setup-engine.sh` builds without `metal`, and on glibc older than 2.38
(Ubuntu 22.04) links small forwarders for the `__isoc23_strto*` symbols that ort's
prebuilt ONNX Runtime needs. Copies use `cp --reflink=auto` instead of APFS clones.

## Use

One phase (8 to 15 minutes; with Sonnet 5, 45 to 120 model requests and over a million
input tokens, nearly all cached, out of the account's AI allowance):

```sh
uv run wfeval run --variant variants/baseline.json --suite receipts --seed 1 --phases 1
uv run wfeval grade runs/<the run's directory>
```

`run` prints each phase's status; `grade` prints one JSON line per phase: the checks,
the score, the mistake tags (`MISTAKES.md`) and usage. A run is graded against the truth
it ran with; `grade --truth data/<suite>-s<seed>/truth.json <runs>` regrades it (a full
or a stage run) against the current one (a synonym added, say) when the history is unchanged. A full run is three phases
(drop `--phases`), about an hour, most of it waiting for the next cycle to be allowed.

Comparing:

```sh
uv run wfeval run --variant variants/baseline.json --suite receipts --seed 1 --repeat 2
uv run wfeval compare --a runs/*-baseline-*-r1 --b runs/*-baseline-*-r2      # A/A: the noise
uv run wfeval compare --a runs/*-baseline-* --b runs/*-myvariant-*
uv run --group dev pytest -q   # offline: generator, grader, negative controls, sandbox
```

Several runs at once: each takes the first free slot (4 per Mac), so start them from
separate shells or in the background. They share the account's allowance and its rate
limit.

```sh
for r in 1 2 3; do uv run wfeval run --suite receipts --seed 1 --repeat $r --phases 1 & done; wait
```

Suites: `receipts` (develop against it; Sonnet 5 is near its ceiling) and `busy` (five
days, four jobs, one a look-alike of receipt filing, one seen on only two days, two
one-offs, noise in the jobs' own apps; `DATA.md`).

A variant is a JSON file: `binary` (an engine built from another branch), `model`
(`intelligent`, `private`, `preset:<id>`), `pipes` (replacement `pipe.md` per workflow
agent), `env`. Anything that changes what the agents see or run is a variant.

### Changing Workflows

The harness never calls workflow code: it drives the engine's HTTP API and grades the
catalog the engine writes. Prompts, Rust logic, routing, the model and the number of
calls can all change. Build your branch with `patches/harness.patch` applied (it
touches the engine binary, the router and a new seed route, no workflow code), point a
variant's `binary` at it and its `source` at the branch's checkout (so `run.json`
records that branch's changed files), then run
`uv run wfeval check-engine --variant <yours>` before spending anything. It fails, with
what to do, when your branch breaks something the harness relies on:

To share a branch, save it as `patches/variants/<name>.patch` (its diff on top of
`harness.patch`) next to `variants/<name>.json` with `binary`
`.engines/target-wf-<name>/debug/screenpipe` and `source` `.engines/wf-<name>`:
`./setup-engine.sh <name>` then builds the same engine on any Mac, and `run.json`
records the same changed files. EXPERIMENTS.md logs what each one measured.

| The harness relies on | Adapt, if your change breaks it |
|---|---|
| the patch applies and `/eval/seed` writes frames | re-apply the patch (it has applied to `screenpipe-source` and `lilwang`) |
| four Pi pipes `workflow-{discover,deepen,review,maintain}` | `TASKS` (engine.py), `ORDER` (stage.py) |
| `/workflows/workspace` starts a cycle; it ends `complete` with `checkedThrough` at its end | `start_cycle`, `wait_cycle` (engine.py) |
| published workflows in `analysis.workflows[]`, citing `{timestamp, app}` | `cited`, `authored` (grade.py) |
| drafts in `agentWorkspace.drafts[].payload` (stage runs) | `as_workflow` (stage.py) |
| model calls go through Pi | usage counts only Pi's requests (the sandbox extension logs them): a change that calls a model elsewhere (Rust, a local server) must log those calls to `requests.jsonl`, or its cost is understated |

The check can't see two things without a model: whether the account's tier offers the
variant's model (a run catches a swap and marks the phase `invalid`) and the shape of a
published workflow (the first graded phase shows it).

Every live cycle spends the account's AI allowance. Failures of the provider or account
(allowance, rate limit, sign-in, 5xx) mark a phase `rerun`; it is never scored. A model
the account's tier does not offer is silently swapped by the engine (to `auto`); the
harness catches that in the engine log and marks the phase `invalid`, also never scored.
An engine that declines to start a cycle (its start returns `idle`: nothing was recorded
after the last checked period, as in `variants/idle-skip.json`) runs no agent in that
phase; the phase is graded as it stands, with `cycle_status: idle` in its `phase.json`.

## Stage runs

A cycle is 8 to 15 minutes and most of its variance comes from Discover. To work on one
agent, save the states between agents once, then rerun only that agent from a state:

```sh
uv run wfeval snapshot --suite receipts --seed 1 --phases 1,2    # one serial cycle per phase
ls snapshots/*/steps/      # 01-p1-workflow-discover, 02-p1-workflow-maintain, ..., NN-p1-complete
uv run wfeval stage snapshots/<id>/steps/<NN>-p1-workflow-review --variant variants/mine.json --repeat 1
uv run wfeval compare --a runs/*-baseline-stage-review-* --b runs/*-mine-stage-review-*
```

`snapshot` runs the agents one at a time (Discover, Maintain, then Deepen and Review as
they become ready; every pipe is disabled, so nothing starts on its own) and saves the
engine's data before each step: the history index, the catalog with its workspace (the
drafts and handoffs), the pipe dirs. `stage <step>` restores one in a slot and runs the
agent the step was saved before (or `--task`) once. It grades what that agent produces:
the drafts for Discover, Deepen and Maintain, the published catalog for Review, with the
same checks as a phase, and records both views and the grade before. It grades with the
snapshot's truth and says when `data/<suite>-s<seed>/truth.json` has changed since (a new
synonym, say): regrade with `grade --truth`, as for a full run. Each result records
`truth`, an id of the truth that graded it, and `compare` warns when its runs differ
there. A Review result also reports `clipped`: each string Review published that the
catalog saved shorter (the engine bounds text fields; checks cannot see this, because
the same words often survive in another field). Every grade, a phase's or a stage's,
also reports `in_stages` for each passing keyword check: whether its words are in the
stages, which say what to do, or only in a variation, question or limitation
("how do missing-date rows get resolved?" passes `missing_date`). Reported, not scored,
so scores stay comparable with every run graded before it; `compare` prints it per
check. Because the serial
order is not the app's (it runs ready agents at once), a snapshot is a fixed starting
point, not a replay of a production cycle; a variant that changes the handoffs still
needs full runs.

A snapshot is shared, not retaken: taking one costs a cycle's worth of model calls (87
requests for receipts seed 1, phase 1: Discover 10, Maintain 4, Deepen 13, Review 60), and
the restored slot path is the same on every Mac.

`stage <step> --through <task>` also runs the agents after the step's, in the snapshot's
serial order and in the same slot, and grades the last one's view; `usage.by_task` splits
the requests. Use it when a change moves work between agents: from Deepen's step,
`--through workflow-review` measures Deepen and Review together (about 30 requests).

`uv run wfeval probe-publish snapshots/<id>/steps/<NN>-p1-workflow-review --variant <v>`
costs nothing: it restores the step and asks the engine to publish each open draft as
the agents left it, with no model. A variant that changes publication checks shows its
effect there before a Review stage pays for the retries. `--parallel` sends all those
publishes at once against the same revisions, as Review does when it publishes several
drafts in one turn.

`uv run wfeval why-rejected runs/<id>` also costs nothing: for each rejected publish in
a run, it checks every stage evidence entry and procedure item the agent submitted
against the seeded captures and says what failed (a capture missing from the stage's
evidence, no capture at that exact time, a quote not in that capture). The engine's 422
names none of this.

## Sharing a run or a snapshot

Never zip `runs/<id>` or `snapshots/<id>` by hand: a run folder keeps the engine's home,
with your screenpipe session token (store.bin, Pi's auth.json), and older snapshots keep it
in store.bin. Use:

```sh
uv run wfeval pack runs/<id>        # or snapshots/<id>; writes <id>.zip here
unzip <id>.zip                      # the teammate, in eval/: lands in runs/ or snapshots/
```

`pack` leaves out `home/` and `tmp/` (grading needs neither), drops the login from every
store.bin, and refuses if a token, an API key or the account's email is still in a file.
Snapshots no longer save the login; a stage restores the template's.

## Same inputs on every Mac

What the agents are given depends on the eval version and nothing else:

- **History**: generated from (suite, seed) alone, hashed in `run.json` (`data`). Seeded
  frames sit at fixed offsets from the run day in UTC, so two runs differ by one date
  shift (the engine reads the real clock; faking it is out of scope).
- **Prompts**: a run happens at `/Users/Shared/wfeval/live` on port 3036 with user
  `eval`, TZ UTC, and a container with a fixed hostname, then moves to `runs/`. So paths,
  port and timezone in the prompts are the same everywhere. A run in slot k sees
  `live<k>` and port `3036+k` instead; its prompt hashes mask both back to slot 0's, and
  `run.json` records the slot. Pass `--slot 0` when the agents must see exactly what
  earlier serial runs saw.
- **No host files**: Pi adds every `AGENTS.md`/`CLAUDE.md` from the agent's directory up
  to `/` to its system prompt; the run refuses to start if one is there.
- **Checked per run**: `prompts/` keeps everything each agent is given before any tool
  result (system prompt, task prompt, tool definitions) with the clock and engine ids
  masked; `run.json` hashes them and lists any host path found in
  prompts or tool output (`host_path_leaks`). `compare` warns when an A/A pair's prompts
  differ or a run leaked. `run.json` also records the engine (its commit, and each file
  that differs from it: `changes`), Pi (and its lockfile), bun (from the installed
  screenpipe app) and the image, which must match to compare
  (`sandbox_image_published`: Docker names one image by either of two digests, so the
  raw id differs between OrbStack and Docker Desktop).

## First results (2026-10-17, receipts seed 1, Sonnet 5)

Phase 1, four repeats:

| repeat | score | missed | agent runs | requests | time |
|---|---|---|---|---|---|
| 1 | 11/11 | - | 13 | (undercounted) | 904 s |
| 2 | 10/11 | the email job: discover saw two of its three instances and called them one-offs | 8 | 45 | 468 s |
| 3 | 11/11 | - | 11 | 82 | 544 s |
| 4 | 10/11 | the email job again | 9 | 47 | 348 s |

Runs 1 and 2 predate the isolation above: an `AGENTS.md` from the directory above the
harness was in their agents' system prompts. Runs 3 and 4 have nothing from the machine,
and their agents' prompts hash the same (all eight), so on one Mac the inputs repeat.

Phases 2 and 3 (run 4): the naming-rule change updated the existing workflow (`drift`
passes; 55 requests, 543 s). The idle cycle, with nothing new, was the most expensive
phase: 93 requests (Maintain 45, Review 39, Discover 9), 3.7M cached input tokens,
678 s, and it rewrote the receipt workflow (`idle_churn`: revision 2 to 3, the text
condensed, a timing sample added) with no new evidence.

Stage runs: a snapshot of phase 1 (serial agents, 87 requests, about 10 min), then
Review alone from the state before it (56 requests, 472 s) gave the same result as the
snapshot's own Review step: drafts at 11/11 in, catalog 11/11 out (after `missing-date`
was added as a synonym; before, both lost that check to the spelling).

The same history gave different catalogs: decide nothing from one run per side. The
email job is found in half the phase-1 runs, the clearest noise so far. The grader
catches damage to a real catalog (`tests/test_controls.py`): a dropped job, a lost
exception, invented evidence and merged jobs each cost exactly their check.

Changes to Workflows, one at a time and then all together, are in `EXPERIMENTS.md`. On
one complete full-run pair (18 October), the final stack (`variants/idle-skip.json`)
took 111 requests against baseline's 213, 92k output tokens against 182k and 619 s of
agent time against 1,538 s, with no check lost. The idle phase went from 56 requests to
none; the gaps in phases 1 and 2 are within baseline's own spread. But an LLM judge,
blind to which run is which, preferred baseline's documents in all 6 pairs (2 workflows ×
3 phases, both orders): its documents miss occurrences and steps the checks do not
test. Traced through the agents, the gaps start in one Discover proposal and one Review
rewrite, not in the review changes. On a second pair, stopped after phase 1, the judge
preferred the stack's receipts document strongly in both orders (baseline's had merged
the email job in). See "LLM judge" in `EXPERIMENTS.md`.

## Limits

Synthetic, clean history: no OCR fallback, no screenshots (`/frames/*` returns a blank
image), no audio or meetings. Results show how a change moves Workflows on controlled
evidence, not how often it finds real work. Tokens are measured; dollars need the model's
prices in `prices.json`, which has none for Sonnet 5 yet (`cost_usd` stays null). The
receipts suite is near the ceiling for Sonnet 5 in phase 1. Not run live yet: the `busy`
suite.
