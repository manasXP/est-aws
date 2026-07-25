import os, sys, subprocess
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import loop_progress as lp


def test_progress_bar_basic():
    out = lp.progress_bar(3, 7)
    assert out.startswith("Q3/7")
    assert "▓▓▓░░░░" in out
    assert "43%" in out


def test_progress_bar_full():
    out = lp.progress_bar(7, 7)
    assert "▓▓▓▓▓▓▓" in out
    assert "100%" in out


def test_progress_bar_zero_total_is_safe():
    # detect-first can drive total to 0; must not divide-by-zero
    out = lp.progress_bar(0, 0)
    assert "100%" in out


def test_phase_breadcrumb_marks_current():
    out = lp.phase_breadcrumb("select")
    assert "elicit" in out and "survey" in out and "select" in out and "scaffold" in out
    assert "you are here: " in out and "select" in out.split("you are here:")[1]


def test_phase_breadcrumb_rejects_unknown():
    try:
        lp.phase_breadcrumb("nope")
    except ValueError:
        return
    assert False, "expected ValueError for unknown phase"


def test_blueprint_box_frames_fields():
    out = lp.blueprint_box([("GOAL", "✓ verifiable"), ("TRIGGER", "schedule · 08:00")])
    lines = out.splitlines()
    assert lines[0].startswith("┌─ LOOP BLUEPRINT")
    assert lines[-1].startswith("└")
    assert any("GOAL" in l and "verifiable" in l for l in lines)
    # every framed line is the same visual width
    framed = [l for l in lines if l.startswith("│")]
    assert len({len(l) for l in framed}) == 1


def test_cli_bar():
    out = subprocess.check_output(
        [sys.executable, os.path.join(os.path.dirname(__file__), "..", "loop_progress.py"), "bar", "3", "7"],
        text=True,
    )
    assert "Q3/7" in out
