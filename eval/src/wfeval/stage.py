"""Stage-level runs: one agent on a fixed workspace, in minutes instead of a cycle.

`wfeval snapshot` runs a suite's phases with the agents one at a time, in a fixed order
(Discover, Maintain, then Deepen and Review as they become ready), and saves the
engine's state before each step. `wfeval stage <snapshot>/steps/<step>` restores that
state in a slot and runs one agent once, under any variant: Review alone on the drafts
Discover and Deepen left, for example. What the agent starts from is the same bytes on
every run, so a stage result varies only with the agent under test, and with the model.

The serial order is not the app's (it runs ready agents at once), so a snapshot is a
fixed, realistic starting point, not a replay of a production cycle.

A snapshot, `snapshots/<utc>-<variant>-<suite>-s<seed>/`:
  snapshot.json   provenance (run.py's), slot, seeded totals, the steps
  seeded.jsonl    truth.json    requests.jsonl    engine.log
  steps/<NN>-p<phase>-<task>/
      state/          what of the engine's data dir is restored (STATE)
      workspace.json  catalog.json   the state as the agents will read it
      step.json       the agent run that followed: status, seconds, usage
      logs/
  steps/<NN>-p<phase>-complete/   the state after the phase's cycle completed

A stage run, `runs/<utc>-<variant>-stage-<task>-<snapshot step>-r<repeat>/`: run.json,
stage.json, workspace/catalog/executions after, logs/, requests.jsonl, prompts/,
results.jsonl (one line: the grade of the stage's view, with the other view and the
grade before).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from . import generate
from .engine import ACTIVE, EVAL_TZ, SLOTS, TASKS, Engine, clone_template, copy_tree
from .grade import clipped, grade_phase, truth_id, ts
from .run import (ROOT, classify, collect_logs, harness, install_overrides, live_slot, model_fallback,
                  provenance, seal, wait_for_room)
from .usage import phase_usage

SNAPSHOTS = ROOT / "snapshots"
# The engine's data that a stage restores; the rest (Pi, the login, the local key) comes
# from the template. Left out: what the engine writes on each start or spawn.
STATE = ["storage", "storage.json", "workflows", "pipes", "store.bin", "workflows-model.json",
         "eval-blank.jpg"]
DROP = ["*.quarantine.reserve.json", "logs", ".trigger-context.json", ".screenpipe-permissions.json"]
# store.bin settings that hold the login (a cloud session JWT, the account): never saved,
# so a snapshot can be shared; a restore keeps the template's.
LOGIN = ("userId", "user")
ORDER = ["workflow-discover", "workflow-maintain", "workflow-deepen", "workflow-review"]
# What a stage produces: Discover, Deepen and Maintain write drafts; Review publishes.
VIEW = {"workflow-discover": "drafts", "workflow-deepen": "drafts", "workflow-maintain": "drafts",
        "workflow-review": "catalog"}


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


# ------------------------------------------------------------------------ state

def save_state(data_dir: Path, dest: Path) -> None:
    """Clones of STATE (`copy_tree`), with the engine stopped (the index is SQLite with a WAL)."""
    dest.mkdir(parents=True)
    for name in STATE:
        if (data_dir / name).exists():
            copy_tree(data_dir / name, dest / name, preserve=True)
    for pattern in DROP:
        for p in list(dest.rglob(pattern)):
            shutil.rmtree(p) if p.is_dir() else p.unlink()
    scrub_store(dest / "store.bin")


def scrub_store(path: Path) -> dict:
    """Removes LOGIN from a store.bin; returns what it removed."""
    if not path.exists():
        return {}
    store = json.loads(path.read_text())
    settings = store.get("settings") or {}
    removed = {k: settings.pop(k) for k in LOGIN if k in settings}
    if removed:
        path.write_text(json.dumps(store, indent=2))
    return removed


def restore_state(state: Path, data_dir: Path, root_then: str, root_now: Path) -> None:
    store = data_dir / "store.bin"
    login = scrub_store(store) if store.exists() else {}  # the template's; put back below
    for name in STATE:
        target = data_dir / name
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()
        if (state / name).exists():
            copy_tree(state / name, target, preserve=True)
    if login and store.exists():
        scrub_store(store)  # older snapshots kept the login of the Mac that took them
        restored = json.loads(store.read_text())
        restored.setdefault("settings", {}).update(login)
        store.write_text(json.dumps(restored, indent=2))
    if root_then != str(root_now):  # taken in another slot: its path in pipe files
        for p in (data_dir / "pipes").rglob("*"):
            if p.is_file() and p.suffix in (".md", ".json", ".ts", ".txt"):
                text = p.read_text(errors="surrogateescape")
                if root_then in text:
                    p.write_text(text.replace(root_then, str(root_now)), errors="surrogateescape")


def as_workflow(payload: dict) -> dict:
    """A draft in the grader's shape. Discover's early drafts are a `candidateTitle` with
    `sources` (`{app, timestamps}`, some of them ranges); a time range is not a citation,
    so only instants count as evidence."""
    w = dict(payload)
    if "title" not in w and w.get("candidateTitle"):
        w["title"] = w["candidateTitle"]
    if w.get("sources") and not w.get("evidence"):
        w["evidence"] = [{"timestamp": t, "app": src.get("app")} for src in w["sources"]
                         for t in src.get("timestamps") or [] if ts(t) is not None]
        w["apps"] = sorted({src.get("app") for src in w["sources"] if src.get("app")})
    return w


def read_view(ws: dict, catalog: dict, view: str) -> dict:
    """A catalog-shaped value to grade: the published catalog, or the cycle's drafts
    (open and published, not rejected) as the workflows they propose."""
    if view == "catalog":
        return catalog
    drafts = [{**as_workflow(d.get("payload") or {}), "id": d.get("id"), "revision": d.get("version")}
              for d in (ws.get("drafts") or {}).values() if d.get("status") != "rejected"]
    return {"analysis": {"workflows": drafts}}


def grade_views(phase: int, ws: dict, catalog: dict, seeded: list[dict], truth: dict,
                previous: list[dict] | None) -> dict:
    out = {}
    for view in ("drafts", "catalog"):
        g = grade_phase(phase, read_view(ws, catalog, view), seeded, truth, previous)
        out[view] = {**{k: v for k, v in g.items() if k != "attributed"},
                     "workflows_by_job": {a["title"]: a["job"] for a in g["attributed"]},
                     "_attributed": g["attributed"]}
    return out


def public(g: dict) -> dict:
    return {k: v for k, v in g.items() if not k.startswith("_")}


# ------------------------------------------------------------------- one agent

def run_agent(engine: Engine, task: str, run_dir: Path, timeout: float) -> dict:
    """Start one manual run of `task` and wait for that execution to end. Every pipe is
    disabled, so nothing else starts: no schedule, no handoff event."""
    before = {e["id"] for e in engine.executions(task, 20)}
    since = datetime.now(timezone.utc).isoformat()
    t0 = time.time()
    started = engine.post(f"/pipes/{task}/run")
    exec_id = started.get("execution_id")
    status, execution = "timeout", None
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        items = engine.executions(task, 20)
        mine = [e for e in items if e["id"] == exec_id] if exec_id else [e for e in items if e["id"] not in before]
        if mine and mine[0]["status"] not in ACTIVE:
            execution, status = mine[0], mine[0]["status"]
            break
        if model_fallback(run_dir):
            status = "aborted"
            break
        time.sleep(5)
    else:
        execution = next((e for e in engine.executions(task, 20) if e["id"] == exec_id), None)
    executions = {t: engine.executions(t, 20) for t in TASKS}
    fallback = model_fallback(run_dir)
    return {"task": task, "execution_id": exec_id, "execution_status": status,
            "error": (execution or {}).get("error_message"), "since": since,
            "seconds": round(time.time() - t0, 1), "model_fallback": fallback,
            "status": "invalid" if fallback else classify(executions, since)
            or ("done" if status == "completed" else status)}


def disable_all(engine: Engine) -> None:
    engine.post("/workflows/rollout", {"enabled": True})  # in memory: every engine start
    for task in TASKS:
        engine.post(f"/pipes/{task}/enable", {"enabled": False})


# --------------------------------------------------------------------- snapshot

def snapshot(variant_path: Path, suite: str, seed: int, phases: list[int], timeout: float,
             slot_no: int | None = None, max_steps: int = 16) -> Path:
    variant = json.loads(variant_path.read_text())
    data = ROOT / "data" / f"{suite}-s{seed}"
    if not (data / "manifest.json").exists():
        generate.write(suite, seed)
    snap_id = f"{stamp()}-{variant['name']}-{suite}-s{seed}"
    final = SNAPSHOTS / snap_id
    final.mkdir(parents=True)
    binary = ROOT / variant.get("binary", ".engines/target/debug/screenpipe")
    seeded_by_phase, steps, model = {}, [], variant.get("price_model")
    with live_slot(slot_no) as (run_dir, port, slot_no):
        try:
            clone_template(run_dir)
            shutil.copy(data / "truth.json", run_dir / "truth.json")
            report = {"run_id": snap_id, "kind": "snapshot", "slot": slot_no, "root": str(run_dir),
                      **provenance(variant, variant_path, data, binary, run_dir)}
            (run_dir / "run.json").write_text(json.dumps(report, indent=1))
            seen: set[Path] = set()
            with harness(run_dir, port, variant, binary) as (engine, box):
                engine.enable_workflows()
                install_overrides(engine, variant)
                engine.set_model(variant.get("model", "intelligent"), variant.get("preset"))
                disable_all(engine)

                def save(name: str) -> Path:
                    step = run_dir / "steps" / name
                    step.mkdir(parents=True)
                    (step / "workspace.json").write_text(json.dumps(engine.workspace(), indent=1))
                    (step / "catalog.json").write_text(json.dumps(engine.catalog(), indent=1))
                    engine.stop()
                    save_state(engine.data, step / "state")
                    engine.start()
                    disable_all(engine)
                    return step

                with open(run_dir / "seeded.jsonl", "a") as seeded_out:
                    for phase in phases:
                        doc = json.loads((data / f"phase{phase}.json").read_text())
                        if doc["frames"]:
                            if phase > 1:
                                wait_for_room(engine, doc["span_seconds"] or 0)
                            frames = generate.anchor(doc, datetime.now(ZoneInfo(EVAL_TZ)))
                            for i, f, src in zip(engine.seed(frames), frames, doc["frames"]):
                                seeded_out.write(json.dumps({
                                    "id": i, "phase": phase, "timestamp": f["timestamp"],
                                    "app_name": f["app_name"], "owner": src["owner"], "run": src["run"],
                                    "step": src["step"]}) + "\n")
                            seeded_out.flush()
                            seeded_by_phase[phase] = {"frames": len(frames),
                                                      "events": sum(len(f["events"]) for f in frames)}
                        engine.post("/workflows/workspace", {"action": "start", "task": TASKS[0]})
                        tries, outcome, first = Counter(), "stalled", len(steps)
                        while len(steps) - first < max_steps:
                            ws = engine.workspace()["workspace"]
                            cycle = ws.get("cycle") or {}
                            if cycle.get("status") == "complete" and engine.catalog().get("checkedThrough") == cycle.get("end"):
                                outcome = "complete"
                                break
                            ready = [t for t in ORDER if engine.workspace(t).get("ready")]
                            ready = [t for t in ready if tries[t] < 4]
                            if not ready:
                                break
                            task = ready[0]
                            tries[task] += 1
                            n = len(steps) + 1
                            step = save(f"{n:02d}-p{phase}-{task}")
                            result = run_agent(engine, task, run_dir, timeout)
                            logs = collect_logs(engine, step / "logs", seen)
                            result["usage"] = phase_usage(logs, model, run_dir / "requests.jsonl", result["since"],
                                                          datetime.now(timezone.utc).isoformat())
                            result.update({"step": step.name, "phase": phase})
                            (step / "step.json").write_text(json.dumps(result, indent=1))
                            steps.append(result)
                            print(f"step {step.name}: {result['status']} in {result['seconds']} s, "
                                  f"{result['usage']['requests']} requests", file=sys.stderr)
                            if result["status"] in ("rerun", "invalid", "aborted"):
                                outcome = result["status"]
                                break
                        save(f"{len(steps) + 1:02d}-p{phase}-{'complete' if outcome == 'complete' else outcome}")
                        print(f"phase {phase}: {outcome}", file=sys.stderr)
                        if outcome != "complete":
                            break
                report["relayed"] = box.portal.connections if box.portal else None
            report.update({"steps": steps, "seeded_by_phase": seeded_by_phase})
            (run_dir / "run.json").write_text(json.dumps(report, indent=1))
        finally:
            for name in ("steps", "seeded.jsonl", "truth.json", "requests.jsonl", "engine.log"):
                if (run_dir / name).exists():
                    shutil.move(str(run_dir / name), str(final / name))
            if (run_dir / "run.json").exists():
                shutil.move(str(run_dir / "run.json"), str(final / "snapshot.json"))
            shutil.rmtree(run_dir)
    return final


# ------------------------------------------------------------------------ stage

def previous_phase(snap: Path, phase: int, seeded: list[dict], truth: dict) -> list[dict] | None:
    """The catalog workflows at the end of the phase before, attributed (for drift)."""
    done = sorted(snap.glob(f"steps/*-p{phase - 1}-complete"))
    if phase <= 1 or not done:
        return None
    catalog = json.loads((done[-1] / "catalog.json").read_text())
    return grade_phase(phase - 1, catalog, seeded, truth)["attributed"]


def stage(step_dir: Path, task: str | None, variant_path: Path, repeat: int, timeout: float,
          slot_no: int | None = None, through: str | None = None) -> Path:
    step_dir = step_dir.resolve()
    snap = step_dir.parents[1]
    meta = json.loads((snap / "snapshot.json").read_text())
    phase = int(step_dir.name.split("-p", 1)[1].split("-", 1)[0])
    if not task and "-workflow-" in step_dir.name:
        task = "workflow-" + step_dir.name.split("-workflow-", 1)[1]
    if task not in TASKS:
        raise SystemExit(f"{step_dir.name} was not saved before an agent: name one with --task")
    # `through`: the agents after it too, in the snapshot's serial order, in the same slot,
    # so a change one agent's output depends on is measured with that agent.
    tasks = ORDER[ORDER.index(task):ORDER.index(through) + 1] if through else [task]
    if not tasks:
        raise SystemExit(f"--through {through} comes before {task}")
    variant = json.loads(variant_path.read_text())
    binary = ROOT / variant.get("binary", ".engines/target/debug/screenpipe")
    suite, seed = meta["data"]["suite"], meta["data"]["seed"]
    names = "-".join(t.removeprefix("workflow-") for t in tasks)
    run_id = f"{stamp()}-{variant['name']}-stage-{names}-{snap.name}-{step_dir.name}-r{repeat}"
    final = ROOT / "runs" / run_id
    final.parent.mkdir(exist_ok=True)
    seeded = [r for l in (snap / "seeded.jsonl").read_text().splitlines()
              if (r := json.loads(l))["phase"] <= phase]  # what the restored index holds
    truth = json.loads((snap / "truth.json").read_text())
    data = ROOT / "data" / f"{suite}-s{seed}"
    current = (data / "truth.json").exists() and json.loads((data / "truth.json").read_text())
    if current and truth_id(current) != truth_id(truth):
        # Graded with the truth it ran with (the snapshot's), so its runs stay comparable.
        print(f"note: {snap.name}/truth.json differs from {data.name}/truth.json; regrade with "
              f"`wfeval grade --truth data/{data.name}/truth.json <run>`", file=sys.stderr)
    previous = previous_phase(snap, phase, seeded, truth)
    before = grade_views(phase, json.loads((step_dir / "workspace.json").read_text())["workspace"],
                         json.loads((step_dir / "catalog.json").read_text()), seeded, truth, previous)
    result = None
    with live_slot(slot_no) as (run_dir, port, slot_no):
        try:
            clone_template(run_dir)
            shutil.copy(snap / "truth.json", run_dir / "truth.json")
            (run_dir / "seeded.jsonl").write_text("".join(json.dumps(r) + "\n" for r in seeded))
            restore_state(step_dir / "state", run_dir / "home/.screenpipe", meta["root"], run_dir)
            report = {"run_id": run_id, "kind": "stage", "slot": slot_no, "snapshot": snap.name,
                      "step": step_dir.name, "task": task,
                      **provenance(variant, variant_path, data, binary, run_dir)}
            (run_dir / "run.json").write_text(json.dumps(report, indent=1))
            with harness(run_dir, port, variant, binary) as (engine, box):
                disable_all(engine)  # after the overrides: a variant's pipe.md may enable
                engine.set_model(variant.get("model", "intelligent"), variant.get("preset"))
                agents = []
                for t in tasks:
                    if not engine.workspace(t).get("ready"):
                        print(f"note: {t} is not ready in this state; it will run anyway", file=sys.stderr)
                    agents.append({"task": t, **run_agent(engine, t, run_dir, timeout)})
                result = {**agents[0], "seconds": round(sum(a["seconds"] for a in agents), 1),
                          "status": next((a["status"] for a in agents if a["status"] != "done"), "done"),
                          **({"agents": agents} if through else {})}
                logs = collect_logs(engine, run_dir / "logs", set())
                result["usage"] = phase_usage(logs, variant.get("price_model"), run_dir / "requests.jsonl",
                                              result["since"], datetime.now(timezone.utc).isoformat())
                ws, catalog = engine.workspace(), engine.catalog()
                for name, value in (("workspace", ws), ("catalog", catalog),
                                    ("executions", {t: engine.executions(t, 20) for t in TASKS})):
                    (run_dir / f"{name}.json").write_text(json.dumps(value, indent=1))
                result["relayed"] = box.portal.connections if box.portal else None
            (run_dir / "stage.json").write_text(json.dumps(result, indent=1))
        finally:
            shutil.move(str(run_dir), str(final))

    run_dir = final
    totals = [v for k, v in meta["seeded_by_phase"].items() if int(k) <= phase]
    report = seal(run_dir, {"frames": sum(t["frames"] for t in totals), "events": sum(t["events"] for t in totals)},
                  result.get("relayed"))
    after = grade_views(phase, ws["workspace"], catalog, seeded, truth, previous)
    view = VIEW[tasks[-1]]
    line = {"variant": variant["name"], "suite": suite, "seed": seed, "repeat": repeat, "phase": phase,
            "stage": "+".join(tasks), "snapshot": f"{snap.name}/{step_dir.name}", "view": view,
            **public(after[view]), "status": result["status"], "usage": result["usage"],
            "seconds": result["seconds"],
            "other_view": {"name": "catalog" if view == "drafts" else "drafts",
                           "score": after["catalog" if view == "drafts" else "drafts"]["score"],
                           "checks": after["catalog" if view == "drafts" else "drafts"]["checks"]},
            "before": {v: {"score": before[v]["score"], "workflows": before[v]["workflows"]} for v in before},
            "prompts": report["prompts"], "host_path_leaks": len(report["host_path_leaks"]),
            "truth": truth_id(truth), **({"clipped": clipped(ws["workspace"], catalog)} if view == "catalog" else {})}
    (run_dir / "results.jsonl").write_text(json.dumps(line) + "\n")
    return run_dir


def regrade(run: Path, truth_file: Path | None = None) -> dict:
    """A stage run's results line graded again from the files it kept, against
    `truth_file` (another version of the suite's truth: the history must be the same)."""
    line = json.loads((run / "results.jsonl").read_text().splitlines()[0])
    truth = json.loads((truth_file or run / "truth.json").read_text())
    seeded = [json.loads(l) for l in (run / "seeded.jsonl").read_text().splitlines()]
    ws = json.loads((run / "workspace.json").read_text())["workspace"]
    catalog = json.loads((run / "catalog.json").read_text())
    snap = ROOT / "snapshots" / line["snapshot"].split("/")[0]
    previous = previous_phase(snap, line["phase"], seeded, truth) if snap.exists() else None
    after = grade_views(line["phase"], ws, catalog, seeded, truth, previous)
    view, other = line["view"], "catalog" if line["view"] == "drafts" else "drafts"
    return {**line, **public(after[view]),
            "other_view": {"name": other, "score": after[other]["score"], "checks": after[other]["checks"]},
            "truth": truth_id(truth), "regraded": truth_file is not None,
            **({"clipped": clipped(ws, catalog)} if view == "catalog" else {})}


def main_snapshot(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="wfeval snapshot")
    ap.add_argument("--variant", type=Path, default=ROOT / "variants" / "baseline.json")
    ap.add_argument("--suite", default="receipts")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--phases", default="1,2")
    ap.add_argument("--timeout", type=float, default=1800, help="seconds per agent run")
    ap.add_argument("--slot", type=int, help=f"0..{SLOTS - 1}; default: the first free one")
    a = ap.parse_args(argv)
    print(snapshot(a.variant, a.suite, a.seed, [int(p) for p in a.phases.split(",")], a.timeout, a.slot))
    return 0


def main_stage(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="wfeval stage")
    ap.add_argument("step", type=Path, help="snapshots/<id>/steps/<NN>-p<phase>-<task>")
    ap.add_argument("--task", choices=TASKS, help="default: the agent the step was saved before")
    ap.add_argument("--variant", type=Path, default=ROOT / "variants" / "baseline.json")
    ap.add_argument("--through", choices=ORDER, help="also run the agents after it, through this one")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--timeout", type=float, default=1800, help="seconds for the agent run")
    ap.add_argument("--slot", type=int, help=f"0..{SLOTS - 1}; default: the first free one")
    a = ap.parse_args(argv)
    out = stage(a.step, a.task, a.variant, a.repeat, a.timeout, a.slot, a.through)
    print(out)
    r = json.loads((out / "results.jsonl").read_text())
    print(json.dumps({k: r[k] for k in ("stage", "view", "status", "passed", "scored", "score", "in_stages",
                                        "mistakes", "before", "seconds") if k in r} | {"requests": r["usage"]["requests"]}
                     | ({"workspace_failed": r["usage"]["workspace"]["failed"]} if "workspace" in r["usage"] else {})
                     | ({"by_task": {t: v["requests"] for t, v in r["usage"].get("by_task", {}).items()}}
                        if "+" in r["stage"] else {})))
    return 0
