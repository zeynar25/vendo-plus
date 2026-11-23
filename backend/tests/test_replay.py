from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import tables
from app.main import create_app, replay_ticks
from app.services.replay import load_sales_use
from tests.helpers import CASE, TZ, comp

START = CASE["decision_time"]                      # a test-period hour from the offline dataset
STOCK = {"coffee": 500.0, "milk": 500.0, "chocolate": 500.0} | {CASE["hopper"]: CASE["stock_g"]}


@pytest.fixture
def client(settings, engine, device_keys):
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def start(client, **overrides):
    body = {"source_start": START, "initial_stock_g": STOCK, "speed": 60, "noise_sd_g": 0.0} | overrides
    return client.post("/api/v1/machines/coffee-01/replay/start", json=body)


def coffee_machine(client):
    return next(m for m in client.get("/api/v1/status").json()["machines"] if m["id"] == "coffee-01")


def test_replay_seeds_24_hours_and_runs_the_model_at_once(client, engine):
    response = start(client)
    assert response.status_code == 200, response.text
    run_id = response.json()["run_id"]
    machine = coffee_machine(client)
    assert machine["mode"] == "replay" and machine["online"] is True
    assert machine["replay"]["source_time"] == datetime.fromisoformat(START).replace(tzinfo=TZ).isoformat()
    assert all(c["method"] == "model" for c in machine["compartments"])
    with engine.connect() as conn:
        seeded = conn.execute(select(func.count()).select_from(tables.readings)
                              .where(tables.readings.c.replay_run_id == run_id)).scalar()
        features = conn.execute(select(tables.predictions.c.features).where(
            tables.predictions.c.replay_run_id == run_id,
            tables.predictions.c.compartment_id == comp(engine, CASE["hopper"])["id"])).scalar()
    assert seeded == 3 * 289                        # 24 h at 5-minute steps, both ends included
    # with noise off, replay reproduces the offline features of that hour exactly
    assert features["stock_ratio"] == pytest.approx(CASE["stock_g"] / 1000)
    for name, expected in CASE["expected"].items():
        assert features[name] == pytest.approx(expected, abs=1e-12), name


def test_each_tick_advances_the_source_clock_and_depletes_stock(client, engine):
    start(client)
    replay_ticks(client.app)                        # one tick: 5 real s x 60 = 5 source minutes
    machine = coffee_machine(client)
    clock = datetime.fromisoformat(machine["replay"]["source_time"])
    assert clock == datetime.fromisoformat(START).replace(tzinfo=TZ) + timedelta(minutes=5)
    data = load_sales_use()
    hopper = next(c for c in machine["compartments"] if c["code"] == CASE["hopper"])
    used = data.used(CASE["hopper"], datetime.fromisoformat(START), clock.replace(tzinfo=None))
    assert hopper["value"] == pytest.approx(max(0.0, CASE["stock_g"] - used))


def test_replay_finishes_at_the_end_of_the_sales_data(client):
    last = load_sales_use().last
    assert start(client, source_start=(last - timedelta(minutes=3)).isoformat()).status_code == 200
    replay_ticks(client.app)                        # +5 source minutes passes the last sale
    machine = coffee_machine(client)
    assert machine["mode"] == "live" and machine["replay"] is None


def test_stop_returns_to_live_mode(client):
    start(client)
    assert client.post("/api/v1/machines/coffee-01/replay/stop").json()["status"] == "stopped"
    assert coffee_machine(client)["mode"] == "live"
    assert client.post("/api/v1/machines/coffee-01/replay/stop").status_code == 409


@pytest.mark.parametrize("path, overrides, code", [
    ("/api/v1/machines/snack-01/replay/start", {}, 422),                         # coffee machine only
    ("/api/v1/machines/tea-99/replay/start", {}, 404),
    (None, {"source_start": "2024-03-01T12:00:00"}, 422),                        # no 24 h of sales before it
    (None, {"initial_stock_g": {"coffee": 100.0}}, 422),
    (None, {"initial_stock_g": {"coffee": 100.0, "milk": 0.0, "chocolate": 50.0}}, 422),
    (None, {"speed": 600}, 422),                                                 # readings would be 50 min apart
])
def test_invalid_replay_requests(client, path, overrides, code):
    body = {"source_start": START, "initial_stock_g": STOCK, "speed": 60} | overrides
    response = client.post(path or "/api/v1/machines/coffee-01/replay/start", json=body)
    assert response.status_code == code, response.text


def test_only_one_replay_at_a_time(client):
    assert start(client).status_code == 200
    assert start(client).status_code == 409
