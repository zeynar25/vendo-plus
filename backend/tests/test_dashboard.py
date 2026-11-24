from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app import tables
from app.db import utcnow
from app.main import create_app
from tests.helpers import CASE, add, comp, day_of_history


@pytest.fixture
def client(settings, engine, device_keys):
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def post(client, keys, readings, machine="coffee-01", seq=1):
    body = {"machine_id": machine, "session_id": "s", "sequence": seq, "readings": readings}
    response = client.post("/api/v1/readings", json=body, headers={"X-Device-Key": keys[machine]})
    assert response.status_code == 201, response.text


def machine(status, machine_id):
    return next(m for m in status["machines"] if m["id"] == machine_id)


def test_before_any_reading_everything_is_offline_and_unlabelled(client):
    status = client.get("/api/v1/status").json()
    assert [m["id"] for m in status["machines"]] == ["coffee-01"]
    coffee = machine(status, "coffee-01")
    assert coffee["online"] is False and coffee["mode"] == "live"
    assert all(c["label"] is None and c["reason"] == "no_reading" and c["stale"] for c in coffee["compartments"])


def test_compartments_are_ranked_by_urgency_then_lowest_stock(client, device_keys):
    post(client, device_keys, [
        {"compartment": "coffee", "value": 30.0, "status": "ok", "calibration_version": 1},
        {"compartment": "milk", "value": 600.0, "status": "ok", "calibration_version": 1},
        {"compartment": "chocolate", "value": None, "status": "unavailable", "calibration_version": 1}])
    coffee = machine(client.get("/api/v1/status").json(), "coffee-01")
    assert coffee["online"] is True
    assert [c["code"] for c in coffee["compartments"]] == ["coffee", "milk", "chocolate"]
    first = coffee["compartments"][0]
    assert (first["label"], first["method"], first["reason"], first["percent"]) == ("High", "basic", "history_short", 3.0)
    assert coffee["compartments"][2]["label"] is None and coffee["compartments"][2]["reason"] == "invalid_reading"


def test_reading_age_marks_stale_after_10_s_and_offline_after_15_s(client, engine):
    hopper = comp(engine, "coffee")
    now = utcnow()
    with engine.begin() as conn:
        conn.execute(tables.readings.insert().values(compartment_id=hopper["id"], t=now - timedelta(seconds=12),
                     received_at=now - timedelta(seconds=12), value=800.0, status="ok", calibration_version=1))
    coffee = machine(client.get("/api/v1/status").json(), "coffee-01")
    row = next(c for c in coffee["compartments"] if c["code"] == "coffee")
    assert row["stale"] is True and coffee["online"] is True
    with engine.begin() as conn:
        conn.execute(tables.readings.update().values(received_at=now - timedelta(seconds=20)))
    assert machine(client.get("/api/v1/status").json(), "coffee-01")["online"] is False


def test_an_acknowledged_alert_stays_hidden_until_the_urgency_changes(client, engine, device_keys):
    def coffee_row(status):
        return next(c for c in machine(status, "coffee-01")["compartments"] if c["code"] == "coffee")

    post(client, device_keys, [{"compartment": "coffee", "value": 40.0, "status": "ok", "calibration_version": 1}])
    row = comp(engine, "coffee")
    with engine.begin() as conn:
        conn.execute(tables.acknowledgements.insert().values(compartment_id=row["id"], label="High",
                                                             acknowledged_at=utcnow()))
    assert coffee_row(client.get("/api/v1/status").json())["acknowledged"] is True
    post(client, device_keys, [{"compartment": "coffee", "value": 150.0, "status": "ok", "calibration_version": 1}],
         seq=2)   # High -> Medium
    post(client, device_keys, [{"compartment": "coffee", "value": 40.0, "status": "ok", "calibration_version": 1}],
         seq=3)   # back to High: a new alert, not acknowledged
    assert coffee_row(client.get("/api/v1/status").json())["acknowledged"] is False


def test_compartment_detail_shows_history_rates_and_recent_urgency(client, engine):
    hopper = comp(engine, CASE["hopper"])
    add(engine, hopper["id"], day_of_history())
    detail = client.get(f"/api/v1/compartments/{hopper['id']}").json()
    assert detail["compartment"]["method"] == "model"
    assert set(detail["consumption_per_hour"]) == {"last_1h", "last_6h", "last_24h"}
    assert detail["consumption_per_hour"]["last_24h"] == pytest.approx(CASE["expected"]["rate_24h"] * 1000, abs=0.01)
    assert 280 <= len(detail["history"]) <= 290            # 24 h at one point per 5 minutes
    assert detail["clock"] == "live"


def test_unknown_compartment_is_404(client):
    assert client.get("/api/v1/compartments/9999").status_code == 404
