from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import tables
from app.main import create_app
from app.services.urgency import basic_label, evaluate, evaluate_and_log
from tests.helpers import CASE, MODEL, TZ, add, add_legacy_machine, comp, day_of_history


def test_basic_warning_thresholds():
    assert basic_label(50, 1000) == "High" and basic_label(51, 1000) == "Medium"
    assert basic_label(200, 1000) == "Medium" and basic_label(201, 1000) == "Low"
    assert basic_label(0, 10) == "High" and basic_label(2, 10) == "Medium" and basic_label(3, 10) == "Low"


@pytest.mark.parametrize("items, label", [(0, "High"), (2, "Medium"), (3, "Low")])
def test_a_leftover_coil_row_always_gets_the_basic_warning(engine, device_keys, items, label):
    add_legacy_machine(engine)
    row = comp(engine, "row-a")
    add(engine, row["id"], [(datetime(2026, 11, 19, 6, tzinfo=TZ), float(items), "ok")])
    with engine.connect() as conn:
        urgency = evaluate(conn, row, TZ, MODEL)
    assert (urgency.label, urgency.method, urgency.reason) == (label, "basic", "coil_row")


def test_short_history_gets_the_basic_warning(engine, device_keys):
    hopper = comp(engine, CASE["hopper"])
    add(engine, hopper["id"], day_of_history(stock_end=40.0, hours=20))
    with engine.connect() as conn:
        urgency = evaluate(conn, hopper, TZ, MODEL)
    assert (urgency.label, urgency.method, urgency.reason) == ("High", "basic", "history_short")


def test_full_history_runs_the_model_on_training_identical_features(engine, device_keys):
    hopper = comp(engine, CASE["hopper"])
    add(engine, hopper["id"], day_of_history())
    with engine.connect() as conn:
        urgency = evaluate(conn, hopper, TZ, MODEL)
    assert urgency.method == "model" and urgency.reason is None
    for name, expected in CASE["expected"].items():
        assert urgency.features[name] == pytest.approx(expected, abs=1e-12)
    assert urgency.label == MODEL.predict(urgency.features)
    assert urgency.model_version == MODEL.sha256


def test_without_a_model_the_basic_warning_says_so(engine, device_keys):
    hopper = comp(engine, CASE["hopper"])
    add(engine, hopper["id"], day_of_history())
    with engine.connect() as conn:
        urgency = evaluate(conn, hopper, TZ, None)
    assert (urgency.method, urgency.reason) == ("basic", "model_unavailable")


def test_invalid_current_reading_has_no_label(engine, device_keys):
    hopper = comp(engine, CASE["hopper"])
    rows = day_of_history()
    rows[-1] = (rows[-1][0], None, "unavailable")
    add(engine, hopper["id"], rows)
    with engine.connect() as conn:
        urgency = evaluate(conn, hopper, TZ, MODEL)
    assert (urgency.label, urgency.reason) == (None, "invalid_reading")


def test_a_calibration_change_starts_a_new_24_hour_history(engine, device_keys):
    hopper = comp(engine, CASE["hopper"])
    rows = day_of_history()
    add(engine, hopper["id"], rows[:-24], calibration=1)
    add(engine, hopper["id"], rows[-24:], calibration=2)     # last 2 hours on a new calibration
    with engine.connect() as conn:
        urgency = evaluate(conn, hopper, TZ, MODEL)
    assert (urgency.method, urgency.reason) == ("basic", "history_reset")


def count_predictions(engine):
    with engine.connect() as conn:
        return conn.execute(select(func.count()).select_from(tables.predictions)).scalar()


def test_predictions_are_logged_on_change_and_at_least_hourly(engine, device_keys):
    row = comp(engine, "milk")
    t0 = datetime(2026, 11, 19, 6, tzinfo=TZ)
    add(engine, row["id"], [(t0, 500.0, "ok")])
    with engine.begin() as conn:
        evaluate_and_log(conn, row, TZ, MODEL, made_at=t0, interval_s=3600)
        evaluate_and_log(conn, row, TZ, MODEL, made_at=t0 + timedelta(seconds=5), interval_s=3600)
    assert count_predictions(engine) == 1                       # same urgency: not stored again
    add(engine, row["id"], [(t0 + timedelta(seconds=10), 100.0, "ok")])
    with engine.begin() as conn:
        evaluate_and_log(conn, row, TZ, MODEL, made_at=t0 + timedelta(seconds=10), interval_s=3600)
    assert count_predictions(engine) == 2                       # Low -> Medium: stored
    with engine.begin() as conn:
        evaluate_and_log(conn, row, TZ, MODEL, made_at=t0 + timedelta(hours=2), interval_s=3600)
    assert count_predictions(engine) == 3                       # unchanged but an hour passed


def test_posting_a_batch_logs_urgency_for_valid_readings(settings, engine, device_keys):
    body = {"machine_id": "coffee-01", "session_id": "s", "sequence": 1,
            "readings": [{"compartment": "coffee", "value": 30.0, "status": "ok", "calibration_version": 1},
                         {"compartment": "milk", "value": 600.0, "status": "ok", "calibration_version": 1},
                         {"compartment": "chocolate", "value": None, "status": "unavailable",
                          "calibration_version": 1}]}
    with TestClient(create_app(settings)) as client:
        assert client.post("/api/v1/readings", json=body,
                           headers={"X-Device-Key": device_keys["coffee-01"]}).status_code == 201
    with engine.connect() as conn:
        rows = conn.execute(select(tables.predictions.c.label, tables.predictions.c.reason,
                                   tables.compartments.c.code).join(tables.compartments)).all()
    assert sorted(rows, key=lambda r: r.code) == [("High", "history_short", "coffee"),
                                                  ("Low", "history_short", "milk")]


def test_kit_readings_do_not_drive_urgency_during_replay(settings, engine, device_keys):
    with engine.begin() as conn:
        conn.execute(tables.machines.update().where(tables.machines.c.id == "coffee-01").values(mode="replay"))
    body = {"machine_id": "coffee-01", "session_id": "s", "sequence": 1,
            "readings": [{"compartment": "coffee", "value": 30.0, "status": "ok", "calibration_version": 1}]}
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/v1/readings", json=body, headers={"X-Device-Key": device_keys["coffee-01"]})
    assert response.status_code == 201 and response.json()["machine_mode"] == "replay"
    assert count_predictions(engine) == 0
