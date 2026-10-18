import json
import re

import pytest

from wfeval import generate, stories
from conftest import NOW


def test_deterministic(tmp_path):
    a = generate.write("receipts", 3, tmp_path / "a")
    b = generate.write("receipts", 3, tmp_path / "b")
    for name in ("phase1.json", "phase2.json", "truth.json", "manifest.json"):
        assert (a / name).read_bytes() == (b / name).read_bytes()


def test_seeds_differ():
    p1, _ = generate.build("receipts", 1)
    p2, _ = generate.build("receipts", 2)
    assert p1[1]["frames"][0]["t"] != p2[1]["frames"][0]["t"]


def test_recurrence_and_one_off(built):
    phases, truth = built
    days = lambda job: {f["day"] for f in phases[1]["frames"] if f["owner"] == job}
    assert len(days("receipts")) >= 3 and len(days("email")) >= 3
    assert len(days("printer")) == 1


def test_phase1_inside_window_phase2_before_seeding(built):
    phases, _ = built
    assert {f["day"] for f in phases[1]["frames"]} <= {-6, -5, -4, -3, -2, -1}
    assert all(generate.DAY_START <= f["t"] <= generate.DAY_END for f in phases[1]["frames"])
    assert all(f["t"] < 0 for f in phases[2]["frames"])


def test_refuses_ungrounded_check(monkeypatch):
    original = stories.receipts

    def broken(rng, *a, **k):
        suite = original(rng, *a, **k)
        suite.truth["checks"].append({"id": "x", "job": "receipts", "phase": 1, "kind": "keywords",
                                      "any": ["x"], "on_screen": ["text no frame shows"]})
        return suite

    monkeypatch.setitem(stories.SUITES, "receipts", broken)
    with pytest.raises(generate.SuiteError, match="text no frame shows"):
        generate.build("receipts", 1)


def test_refuses_leak(monkeypatch):
    monkeypatch.setattr(stories, "ARTICLES", [("Eval results", "https://x.example/a", ["test"])])
    with pytest.raises(generate.SuiteError, match="leak"):
        generate.build("receipts", 1)


def test_anchor_fills_dates_and_utc(built):
    phases, _ = built
    frames = generate.anchor(phases[1], NOW)
    assert all(f["timestamp"].endswith("Z") for f in frames)
    assert not any("⟦" in f["accessibility_text"] for f in frames)
    assert set(frames[0]) >= {"timestamp", "app_name", "window_name", "capture_trigger", "accessibility_text"}
    assert "owner" not in frames[0]
    p2 = generate.anchor(phases[2], NOW)
    assert max(f["timestamp"] for f in p2) < NOW.astimezone(generate.timezone.utc).isoformat().replace("+00:00", "Z")


def test_busy_suite_is_deterministic_and_has_its_hard_parts(tmp_path):
    a = generate.write("busy", 2, tmp_path / "a")
    b = generate.write("busy", 2, tmp_path / "b")
    assert (a / "manifest.json").read_bytes() == (b / "manifest.json").read_bytes()
    phases, truth = generate.build("busy", 1)
    days = lambda job: {f["day"] for f in phases[1]["frames"] if f["owner"] == job}
    assert len(days("hours")) == 2 and truth["jobs"]["hours"]["min_days"] == 2
    assert len(days("photos")) == 1 and len(days("invoices")) >= 3
    noise_apps = {f["app_name"] for f in phases[1]["frames"] if f["owner"] == "noise"}
    assert noise_apps & {"Preview", "Mail", "Finder"}  # noise in the jobs' own apps
