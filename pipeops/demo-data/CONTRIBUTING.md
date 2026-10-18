# Contributing an experiment to Demo Runs

Every `*.json` file in this folder that passes validation shows up in PipeOps →
Step 01 → **Demo runs**. No code change, no restart. Each file is one completed **full**
`wfeval` evaluation in the portable `pipeops.run` v1 format (see `server/portable.mjs`).

## 1. Export your run

You need a finished, graded run in `eval/runs/` (from `wfeval run` + `wfeval grade`, or the
"Run new experiment" button). From `pipeops/`:

```sh
ls ../eval/runs                                   # find your run id (a folder name)
npm run export-run -- <runId>                     # writes demo-data/<runId>.json
```

The exporter builds the file from an allowlist (metrics, ground truth, checks, workflows,
model usage, provenance hashes), refuses to write if validation fails, and never overwrites
an existing file unless you pass `--force`.

## 2. Validate

```sh
npm run validate-demo                             # every file in demo-data/
npm run validate-demo -- demo-data/<runId>.json   # just yours
npm test                                          # full non-LLM test suite (no model calls)
```

## 3. Review before you share  (required)

Open the JSON and read it. It should contain only workflow titles, check results and
numbers. Look for anything you would not post publicly: real names, customer data,
internal URLs, file paths. The validator blocks credentials, tokens, emails and
`/Users/<name>` paths, but it cannot judge whether *your* recorded content is private. If
your run used real (not seeded/synthetic) screen data, don't contribute it.

## 4. Open a PR

```sh
git checkout -b experiment/<short-name>
git add pipeops/demo-data/<runId>.json           # only your file; never `git add .`
git commit -m "pipeops: add demo run <short-name>"
git push -u origin experiment/<short-name>
gh pr create --fill
```

## What is (and is not) in a file

Included: run id/variant/timestamps, test conditions (suite, seed, phases, data hashes),
ground truth, per-check results, generated workflows, token/request/runtime totals, and
provenance hashes (variant, prompts, engine commit). Anything the run didn't record is
`null`, never guessed (e.g. `costUsd`).

Never included: `engine.log`, `requests.jsonl` (raw model traffic), `seeded.jsonl`,
prompts, `home/`, `tmp/`, agent logs, engine binary path, API keys or login state.
Home-directory paths found inside generated text are replaced with `/Users/<redacted>`
and counted in `provenance.sanitization`.

## Comparability

Two runs only compare in Step 04 when they share suite, seed, phases and
test-data hashes (`conditions`). `repeat` (the `-rN` of the id) is recorded but does not
block a pair: two replicates of the same test are comparable. Runs from other conditions are listed but are never paired.

## Limitation: stage runs

Stage runs (`wfeval stage …`, e.g. a Clearer-rejection Review replay) grade one agent on a
saved workspace, not a full cycle, so their scores are **not** comparable to full
evaluations. The exporter refuses them (`stage run, not a full evaluation`) and Local runs
doesn't list them. A separate stage format is not defined yet.

## Adding an LLM-judge review to a pair

Compare shows a judge's verdict next to the automatic checks only when a review file for
exactly that pair exists in `demo-data/reviews/`. Build it from the judge's own folder:

```sh
npm run import-judge -- ../eval/judge <baselineRunId> <variantRunId>
```

It refuses unless the judge's `build.py` names both runs and every judgment in `key.json` has a
result. The file keeps verdicts and scores (never the judges' free text) and the sha256 of
every input. Read it before committing.
