"""The live feature code must reproduce ml/features.py exactly on the same sales.

Each fixture case is a test-period row of the offline dataset (100 g level): its
decision time, hopper, true stock, the 11 expected features, and the hopper's sales
in the 25 hours before. Readings are rebuilt every 5 minutes with no noise, so the
live consumption estimate must equal the training value to floating-point precision.
"""

import json
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app.ml.features import FEATURE_COLUMNS, Reading, RefillSpan, compute_features

TZ = ZoneInfo("Asia/Manila")
CASES = json.loads((Path(__file__).parent / "fixtures" / "feature_parity_cases.json").read_text())


def local(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=TZ)


def readings_for(case, step_min=5, hours=25, noise=None):
    t = local(case["decision_time"])
    sales = [(local(s), g) for s, g in case["sales"]]
    out = []
    for k in range(hours * 60 // step_min, -1, -1):
        tau = t - timedelta(minutes=k * step_min)
        used_after = sum(g for when, g in sales if tau < when <= t)
        out.append(Reading(t=tau, value=case["stock_g"] + used_after, status="ok"))
    return out


@pytest.mark.parametrize("case", CASES, ids=[f"{c['hopper']}-{c['decision_time']}" for c in CASES])
def test_live_features_equal_training_features(case):
    result = compute_features(readings_for(case), [], capacity=1000.0, hopper_type=case["hopper"],
                              tz=TZ, history_start=None)
    assert result.reason is None
    assert list(result.features) == FEATURE_COLUMNS
    assert result.features["stock_ratio"] == pytest.approx(case["stock_g"] / 1000.0)
    for name, expected in case["expected"].items():
        assert result.features[name] == pytest.approx(expected, abs=1e-12), name


def test_time_features_use_the_machine_time_zone_not_utc():
    case = CASES[0]
    utc_readings = [Reading(r.t.astimezone(ZoneInfo("UTC")), r.value, r.status) for r in readings_for(case)]
    result = compute_features(utc_readings, [], capacity=1000.0, hopper_type=case["hopper"],
                              tz=TZ, history_start=None)
    assert result.features["hour_sin"] == pytest.approx(case["expected"]["hour_sin"], abs=1e-12)


def test_less_than_24_hours_of_history_is_not_enough():
    readings = readings_for(CASES[0], hours=23)
    result = compute_features(readings, [], capacity=1000.0, hopper_type="coffee", tz=TZ, history_start=None)
    assert result.features is None and result.reason == "history_short"


def test_a_reset_inside_the_last_24_hours_blocks_the_model():
    readings = readings_for(CASES[0])
    reset_at = readings[-1].t - timedelta(hours=3)
    result = compute_features(readings, [], capacity=1000.0, hopper_type="coffee", tz=TZ,
                              history_start=reset_at, reset_active=True)
    assert result.reason == "history_reset"


def test_a_long_gap_before_a_window_start_blocks_the_model():
    readings = readings_for(CASES[0])
    t = readings[-1].t
    # drop readings from 6 h 30 min to 5 h 40 min ago: the 6 h window start has none within 15 min
    gappy = [r for r in readings if not (t - timedelta(hours=6, minutes=30) < r.t < t - timedelta(hours=5, minutes=40))]
    result = compute_features(gappy, [], capacity=1000.0, hopper_type="coffee", tz=TZ, history_start=None)
    assert result.reason == "history_gap"


def test_a_recorded_refill_inside_the_window_is_added_back():
    base = readings_for(CASES[0])
    t = base[-1].t
    refill_end = t - timedelta(minutes=30)
    # after the refill every reading is 400 g higher
    lifted = [Reading(r.t, r.value + (400.0 if r.t >= refill_end else 0.0), r.status) for r in base]
    refill = RefillSpan(started_at=refill_end - timedelta(minutes=3), ended_at=refill_end, added=400.0)
    plain = compute_features(base, [], capacity=1000.0, hopper_type="coffee", tz=TZ, history_start=None)
    adjusted = compute_features(lifted, [refill], capacity=1000.0, hopper_type="coffee", tz=TZ, history_start=None)
    for name in ("rate_1h", "rate_6h", "rate_24h"):
        assert adjusted.features[name] == pytest.approx(plain.features[name], abs=1e-12)


def test_a_window_starting_during_a_refill_blocks_the_model():
    readings = readings_for(CASES[0])
    t = readings[-1].t
    refill = RefillSpan(started_at=t - timedelta(hours=1, minutes=2), ended_at=t - timedelta(minutes=58), added=50.0)
    result = compute_features(readings, [refill], capacity=1000.0, hopper_type="coffee", tz=TZ, history_start=None)
    assert result.reason == "refill_in_window"


def test_invalid_current_reading_is_a_caller_error():
    readings = readings_for(CASES[0])
    readings[-1] = Reading(readings[-1].t, None, "unavailable")
    with pytest.raises(ValueError):
        compute_features(readings, [], capacity=1000.0, hopper_type="coffee", tz=TZ, history_start=None)
