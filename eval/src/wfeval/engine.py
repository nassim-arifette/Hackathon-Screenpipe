"""Drive one isolated, patched screenpipe engine: start, seed, run a workflow cycle the
way the desktop's "Update now" does (`lib/workflows/scheduled-discovery.ts`), stop.

Isolation: the engine gets a fresh HOME and data dir cloned from a warm template, a
port of its own on 127.0.0.1, and a built environment that inherits nothing from this
shell (Pi inherits the engine's environment, and this shell holds API keys). Nothing in
that environment depends on the machine: user, timezone and locale are fixed, and a run
lives in a fixed slot (`slot()`, run.py), so the agents see the same paths and port on
every Mac. Capture is off: no screen, audio, clicks, keystrokes, clipboard or meetings,
so the only history is what the harness seeds.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zlib
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENGINES = ROOT / ".engines"
BINARY = ENGINES / "target" / "debug" / "screenpipe"
TEMPLATE = ENGINES / "template"
MACOS = sys.platform == "darwin"
# bun and ffmpeg the app ships; on Linux, setup-linux.sh puts the same bun and an ffmpeg there.
APP = Path("/Applications/screenpipe.app/Contents/MacOS") if MACOS else ENGINES / "app"
# What the agents see of the machine, the same everywhere. UTC: no DST shift between runs.
EVAL_TZ = "UTC"
EVAL_USER = "eval"
# Exists on every Mac; no AGENTS.md above it. Linux uses the same path (setup-linux.sh
# creates it) so agents see the same paths there too.
LIVE = Path("/Users/Shared/wfeval/live")
PORT = 3036
SLOTS = 4  # runs at once per Mac


def slot(k: int) -> tuple[Path, int]:
    """Slot 0 is `LIVE` on `PORT`; slot k is `live<k>` on `PORT + k`. Agents in slot k see
    that path and port, which prompt fingerprints mask back to slot 0's (run.py)."""
    if not 0 <= k < SLOTS:
        raise ValueError(f"slot {k} is not in 0..{SLOTS - 1}")
    return (LIVE if k == 0 else LIVE.with_name(f"live{k}")), PORT + k
TASKS = ["workflow-discover", "workflow-deepen", "workflow-review", "workflow-maintain"]
FAILED = {"failed", "cancelled", "interrupted", "timed_out"}
ACTIVE = {"running", "queued"}
RECORD_FLAGS = ["--disable-vision", "--disable-audio", "--disable-click-capture",
                "--disable-keyboard-capture", "--disable-clipboard-capture",
                "--experimental-meeting-piggyback", "false", "--disable-telemetry",
                "--disable-snapshot-compaction"]


class EngineError(Exception):
    pass


def copy_tree(src: Path, dest: Path, preserve: bool = False) -> None:
    """A clone where the filesystem has them (APFS `cp -c`, `--reflink` on Linux), else a copy."""
    if MACOS:
        cmd = ["/bin/cp", "-cRp" if preserve else "-cR"]
    else:
        cmd = ["cp", "--reflink=auto", "-Rp" if preserve else "-R"]
    subprocess.run([*cmd, str(src), str(dest)], check=True)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def blank_jpeg(path: Path) -> Path:
    """The one image every seeded frame points at (DATA.md: frames have no pixels)."""
    if path.exists():
        return path
    png = path.with_suffix(".png")
    raw = b"\x00\xff\xff\xff"
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
                    + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    if MACOS:
        cmd = ["/usr/bin/sips", "-s", "format", "jpeg", str(png), "--out", str(path)]
    else:
        cmd = [str(APP / "ffmpeg"), "-y", "-loglevel", "error", "-i", str(png), str(path)]
    subprocess.run(cmd, check=True, capture_output=True)
    png.unlink()
    return path


def prepare_home(home: Path) -> None:
    """Tools the engine looks up under HOME (`agents/pi.rs`, `find_bun_executable`)."""
    (home / ".bun" / "bin").mkdir(parents=True, exist_ok=True)
    bun = home / ".bun" / "bin" / "bun"
    if not bun.exists():
        bun.symlink_to(APP / "bun")
    (home / ".screenpipe").mkdir(exist_ok=True)


def clone_template(dest: Path) -> None:
    if not (TEMPLATE / "home" / ".screenpipe").exists():
        raise EngineError("no template: run `wfeval template` first")
    dest.mkdir(parents=True, exist_ok=True)
    # A clone (copy_tree): a copy in O(1) that shares blocks until written.
    # -p calls chflags on Bun's absolute cache symlinks and fails with ELOOP on
    # macOS 26. -R retains the private file modes needed for the copied login.
    copy_tree(TEMPLATE / "home", dest / "home")


@dataclass
class Engine:
    run_dir: Path
    port: int = field(default_factory=free_port)
    extra_env: dict[str, str] = field(default_factory=dict)
    binary: Path = BINARY
    proc: subprocess.Popen | None = None
    key: str | None = None  # local API key; required even from 127.0.0.1

    @property
    def home(self) -> Path:
        return self.run_dir / "home"

    @property
    def data(self) -> Path:
        return self.home / ".screenpipe"

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def env(self) -> dict[str, str]:
        tmp = self.run_dir / "tmp"
        tmp.mkdir(parents=True, exist_ok=True)
        return {
            "HOME": str(self.home), "USER": EVAL_USER, "LOGNAME": EVAL_USER,
            "PATH": f"{self.home}/.bun/bin:{APP}:/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": "en_US.UTF-8", "TMPDIR": f"{tmp}/", "TZ": EVAL_TZ,
            "SCREENPIPE_DATA_DIR": str(self.data), "SCREENPIPE_EVAL_SEED": "1",
            "RUST_LOG": "info", **self.extra_env,
        }

    # ------------------------------------------------------------------ lifecycle

    def start(self, timeout: float = 180) -> None:
        prepare_home(self.home)
        self.log_start = (self.run_dir / "engine.log").stat().st_size if (self.run_dir / "engine.log").exists() else 0
        log = open(self.run_dir / "engine.log", "ab")
        self.proc = subprocess.Popen(
            [str(self.binary), "record", "--port", str(self.port), "--data-dir", str(self.data),
             *RECORD_FLAGS],
            env=self.env(), stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            cwd=self.run_dir, start_new_session=True)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise EngineError(f"engine exited with {self.proc.returncode}; see {self.run_dir / 'engine.log'}")
            try:
                self.get("/health")
                self.key = self.local_key()
                self.wait_for_pi(deadline)
                return
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                time.sleep(1)
        raise EngineError("engine not healthy in time")

    def wait_for_pi(self, deadline: float) -> None:
        """The engine reinstalls Pi in the background when it starts. An agent started
        meanwhile loads half-replaced packages and fails before any model request
        ("Cannot find package ..."), so wait for the install to finish."""
        def since_start() -> str:
            with open(self.run_dir / "engine.log", "rb") as f:
                f.seek(self.log_start)
                return f.read().decode(errors="replace")
        time.sleep(2)  # the install, when there is one, is logged right after health
        while "installing pi into" in (text := since_start()):
            if "pi installed successfully" in text:
                return
            if "pi installation failed" in text:
                raise EngineError(f"Pi installation failed; see {self.run_dir / 'engine.log'}")
            if time.monotonic() > deadline:
                raise EngineError("Pi installation did not finish in time")
            time.sleep(1)

    def local_key(self) -> str:
        r = subprocess.run([str(self.binary), "auth", "token"], env=self.env(), capture_output=True,
                           text=True, timeout=60)
        key = next((w for w in r.stdout.split() if w.startswith("sp-")), None)
        if not key:
            raise EngineError(f"no local API key from `screenpipe auth token` (exit {r.returncode})")
        return key

    def stop(self, timeout: float = 30) -> None:
        if not self.proc or self.proc.poll() is not None:
            return
        os.killpg(self.proc.pid, 15)
        try:
            self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, 9)
            self.proc.wait()

    def __enter__(self) -> "Engine":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop()

    # ----------------------------------------------------------------------- http

    def request(self, method: str, path: str, body=None, timeout: float = 60):
        data = None if body is None else json.dumps(body).encode()
        headers = {"Content-Type": "application/json"}
        if self.key:
            headers["Authorization"] = f"Bearer {self.key}"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            raise EngineError(f"{method} {path}: {e.code} {e.read()[:4000].decode(errors='replace')}") from e
        return json.loads(raw) if raw else None

    def get(self, path: str, **kw):
        return self.request("GET", path, **kw)

    def post(self, path: str, body=None, **kw):
        value = self.request("POST", path, {} if body is None else body, **kw)
        if isinstance(value, dict) and value.get("error"):
            raise EngineError(f"POST {path}: {value['error']}")
        return value

    # -------------------------------------------------------------------- history

    def seed(self, frames: list[dict], batch: int = 250) -> list[int]:
        snapshot = blank_jpeg(self.data / "eval-blank.jpg")
        ids = []
        for i in range(0, len(frames), batch):
            out = self.post("/eval/seed", {"device_name": "monitor_1", "snapshot_path": str(snapshot),
                                           "frames": frames[i:i + batch]}, timeout=300)
            ids += out["frames"]
        return ids

    # ------------------------------------------------------------------ workflows

    def set_model(self, mode: str, preset: dict | None = None) -> None:
        """`intelligent`, `private` or `preset:<id>` (`workflows/model_choice.rs`). A preset
        is added to `store.bin`'s `settings.aiPresets`, where the app keeps them."""
        if preset:
            if mode != f"preset:{preset['id']}":
                raise EngineError(f"model {mode!r} does not select preset {preset['id']!r}")
            store_path = self.data / "store.bin"
            store = json.loads(store_path.read_text()) if store_path.exists() else {}
            presets = store.setdefault("settings", {}).setdefault("aiPresets", None) or []
            store["settings"]["aiPresets"] = [p for p in presets if p.get("id") != preset["id"]] + [preset]
            store_path.write_text(json.dumps(store, indent=1))
        (self.data / "workflows-model.json").write_text(json.dumps({"mode": mode}))

    def enable_workflows(self) -> None:
        self.post("/workflows/rollout", {"enabled": True})
        for task in TASKS:
            self.post(f"/pipes/bundled/{task}/install")
        for task in reversed(TASKS):  # Discover last, as the app does
            self.post(f"/pipes/{task}/enable", {"enabled": True})
        for task in TASKS:
            if self.get(f"/pipes/{task}")["data"]["config"]["enabled"] is not True:
                raise EngineError(f"{task} did not enable")

    def workspace(self, task: str = "workflow-review") -> dict:
        return self.get(f"/workflows/workspace?task={task}")

    def catalog(self) -> dict:
        return self.get("/workflows/catalog")

    def executions(self, task: str, limit: int = 50) -> list[dict]:
        return self.get(f"/pipes/{task}/executions?limit={limit}&include_output=false").get("data") or []

    def start_cycle(self) -> dict:
        """`startWorkflowJob`: fix the requested end, then run every ready agent."""
        self.post("/workflows/rollout", {"enabled": True})  # in memory: every engine start
        started = self.post("/workflows/workspace", {"action": "start", "task": TASKS[0]})
        if started.get("idle"):
            # An engine that skips a cycle with nothing new recorded starts no agent.
            return {"cycle": started.get("cycle"), "runs": {}, "idle": started["idle"]}
        ready = [t for t in TASKS if self.workspace(t).get("ready")]
        if not ready:
            raise EngineError("no workflow agent is ready after start")
        runs = {t: self.post(f"/pipes/{t}/run").get("execution_id") for t in ready}
        return {"cycle": started.get("cycle"), "runs": runs}

    def wait_cycle(self, cycle_id: str, timeout: float = 3600, poll: float = 15,
                   stall: float = 900, abort=None) -> dict:
        """Wait for the cycle the way the app judges it (`resolveWorkflowJob`). Agents
        hand off through events and 5-minute readiness checks, so a quiet stretch alone
        is not a failure; `stall` bounds it. `abort(executions)` true ends the wait."""
        deadline = time.monotonic() + timeout
        last_change, last_seen = time.monotonic(), None
        while time.monotonic() < deadline:
            ws = self.workspace()["workspace"]
            cycle = ws.get("cycle") or {}
            if cycle.get("id") != cycle_id:
                return {"status": "lost", "cycle": cycle}
            if cycle.get("status") == "complete" and self.catalog().get("checkedThrough") == cycle.get("end"):
                return {"status": "complete", "cycle": cycle}
            execs = {t: self.executions(t, 5) for t in TASKS}
            if abort and abort(execs):
                return {"status": "aborted", "cycle": cycle}
            seen = (ws.get("revision"), tuple((t, e[0]["id"], e[0]["status"]) for t, e in execs.items() if e))
            if seen != last_seen:
                last_seen, last_change = seen, time.monotonic()
            active = any(e and e[0]["status"] in ACTIVE for e in execs.values())
            if cycle.get("status") == "paused":
                return {"status": "paused", "cycle": cycle}
            if not active and time.monotonic() - last_change > stall:
                return {"status": "stalled", "cycle": cycle}
            time.sleep(poll)
        return {"status": "timeout", "cycle": (self.workspace()["workspace"].get("cycle") or {})}


def make_template(timeout: float = 900) -> Path:
    """Warm template: Pi installed, workflow pipes installed, no history. The cloud
    login is a separate, manual step (`SCREENPIPE_DATA_DIR=<template data> screenpipe login`)."""
    TEMPLATE.mkdir(parents=True, exist_ok=True)
    engine = Engine(TEMPLATE)
    with engine:
        engine.post("/workflows/rollout", {"enabled": True})
        for task in TASKS:
            engine.post(f"/pipes/bundled/{task}/install")
        # The first pipe run installs Pi; wait for its package to land.
        deadline = time.monotonic() + timeout
        pi = engine.data / "pi-agent" / "node_modules" / "@earendil-works" / "pi-coding-agent"
        while not pi.exists() and time.monotonic() < deadline:
            time.sleep(5)
    for name in ("engine.log", "tmp"):
        p = TEMPLATE / name
        shutil.rmtree(p) if p.is_dir() else p.unlink(missing_ok=True)
    return TEMPLATE / "home" / ".screenpipe"
