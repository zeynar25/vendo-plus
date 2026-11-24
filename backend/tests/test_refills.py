from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import tables
from app.main import create_app
from app.services.refills import detect_unrecorded_refill, reconcile
from app.services.urgency import evaluate
from tests.helpers import CASE, MODEL, TZ, add, comp, day_of_history


class Kit:
    """Posts batches the way a kit would, one sequence number at a time."""

    def __init__(self, client, keys):
        self.client, self.keys, self.seq = client, keys, 0

    def send(self, code, value, machine="coffee-01"):
        self.seq += 1
        body = {"machine_id": machine, "session_id": "s", "sequence": self.seq,
                "readings": [{"compartment": code, "value": value, "status": "ok", "calibration_version": 1}]}
        response = self.client.post("/api/v1/readings", json=body, headers={"X-Device-Key": self.keys[machine]})
        assert response.status_code == 201, response.text


@pytest.fixture
def client(settings, engine, device_keys):
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture
def kit(client, device_keys):
    return Kit(client, device_keys)


def coffee_state(client):
    machines = client.get("/api/v1/status").json()["machines"]
    coffee = next(m for m in machines if m["id"] == "coffee-01")
    return next(c for c in coffee["compartments"] if c["code"] == "coffee")


def count(engine, table):
    with engine.connect() as conn:
        return conn.execute(select(func.count()).select_from(table)).scalar()


def test_refill_needs_a_stable_reading_first(client, kit, engine):
    cid = comp(engine, "coffee")["id"]
    kit.send("coffee", 300.0)
    assert client.post(f"/api/v1/compartments/{cid}/refill/start").status_code == 409
    kit.send("coffee", 320.0)
    kit.send("coffee", 301.0)       # three readings, but 20 g apart: still not stable
    response = client.post(f"/api/v1/compartments/{cid}/refill/start")
    assert response.status_code == 409 and response.json()["detail"] == "not stable"


def test_full_refill_records_the_amount_added(client, kit, engine):
    cid = comp(engine, "coffee")["id"]
    for value in (300.0, 301.0, 302.0):
        kit.send("coffee", value)
    started = client.post(f"/api/v1/compartments/{cid}/refill/start")
    assert started.status_code == 200 and started.json()["before_value"] == pytest.approx(301.0)
    state = coffee_state(client)
    assert state["refill_open"] is True and state["label"] is None and state["reason"] == "refill_open"
    kit.send("coffee", 600.0)
    assert client.post(f"/api/v1/compartments/{cid}/refill/end").status_code == 409   # still rising
    for value in (750.0, 751.0, 752.0):
        kit.send("coffee", value)
    ended = client.post(f"/api/v1/compartments/{cid}/refill/end").json()
    assert ended["status"] == "closed" and ended["added"] == pytest.approx(450.0)
    assert count(engine, tables.history_resets) == 0       # a recorded refill is not "unrecorded"
    history = client.get(f"/api/v1/compartments/{cid}/refills").json()
    assert history["refills"][0]["added"] == pytest.approx(450.0) and history["unrecorded_refills"] == []
    assert coffee_state(client)["refill_open"] is False


def test_a_rise_outside_refill_mode_is_an_unrecorded_refill_until_reconciled(client, kit, engine):
    cid = comp(engine, "coffee")["id"]
    kit.send("coffee", 300.0)
    kit.send("coffee", 315.0)       # +15 g: noise-sized, ignored
    assert count(engine, tables.history_resets) == 0
    kit.send("coffee", 500.0)       # +185 g with no refill open
    state = coffee_state(client)
    assert state["unrecorded_refill_id"] is not None
    pending = client.get(f"/api/v1/compartments/{cid}/refills").json()["unrecorded_refills"]
    assert pending[0]["jump"] == pytest.approx(185.0)
    done = client.post(f"/api/v1/history-resets/{pending[0]['history_reset_id']}/reconcile")
    assert done.status_code == 200 and done.json()["added"] == pytest.approx(185.0)
    assert client.get(f"/api/v1/compartments/{cid}/refills").json()["unrecorded_refills"] == []
    assert client.post(f"/api/v1/history-resets/{pending[0]['history_reset_id']}/reconcile").status_code == 409


def test_reconciling_restores_the_model_and_counts_the_refill(engine, device_keys):
    hopper = comp(engine, CASE["hopper"])
    rows = day_of_history()
    add(engine, hopper["id"], rows)
    with engine.connect() as conn:
        before = evaluate(conn, hopper, TZ, MODEL)
    t_jump, value = rows[-1][0] + timedelta(minutes=5), rows[-1][1] + 400.0
    with engine.begin() as conn:
        assert detect_unrecorded_refill(conn, hopper, t_jump, value, "ok") is True
    add(engine, hopper["id"], [(t_jump, value, "ok")])
    with engine.connect() as conn:
        assert evaluate(conn, hopper, TZ, MODEL).reason == "history_reset"
    with engine.begin() as conn:
        reset_id = conn.execute(select(tables.history_resets.c.id)).scalar()
        reconcile(conn, reset_id, t_jump)
    with engine.connect() as conn:
        after = evaluate(conn, hopper, TZ, MODEL)
    assert after.method == "model"
    # the 400 g is added back, so 24 h consumption matches the pre-refill estimate within 5 minutes of sales
    assert after.features["rate_24h"] == pytest.approx(before.features["rate_24h"], abs=0.002)


def test_cancelling_a_refill_after_adding_stock_flags_it(client, kit, engine):
    cid = comp(engine, "coffee")["id"]
    for value in (300.0, 300.0, 300.0):
        kit.send("coffee", value)
    assert client.post(f"/api/v1/compartments/{cid}/refill/start").status_code == 200
    kit.send("coffee", 650.0)
    cancelled = client.post(f"/api/v1/compartments/{cid}/refill/cancel").json()
    assert cancelled["status"] == "cancelled" and cancelled["history_reset"] is True


def test_acknowledge_needs_a_medium_or_high_alert(client, kit, engine):
    cid = comp(engine, "coffee")["id"]
    kit.send("coffee", 800.0)                                   # Low: nothing to acknowledge
    assert client.post(f"/api/v1/compartments/{cid}/acknowledge").status_code == 409
    kit.send("coffee", 40.0)                                    # High
    response = client.post(f"/api/v1/compartments/{cid}/acknowledge")
    assert response.status_code == 200 and response.json()["acknowledged_label"] == "High"
    assert coffee_state(client)["acknowledged"] is True


def test_operator_key_is_required_when_configured(settings, engine, device_keys):
    guarded = settings.model_copy(update={"operator_key": "s3cret"})
    with TestClient(create_app(guarded)) as client:
        cid = comp(engine, "coffee")["id"]
        assert client.post(f"/api/v1/compartments/{cid}/refill/start").status_code == 401
        allowed = client.post(f"/api/v1/compartments/{cid}/refill/start", headers={"X-Operator-Key": "s3cret"})
        assert allowed.status_code == 409   # authorised; refused only because there is no stable reading
        assert client.get("/api/v1/status").status_code == 200   # reading stays open


def test_refill_mode_is_unavailable_during_replay(client, engine):
    with engine.begin() as conn:
        conn.execute(tables.machines.update().where(tables.machines.c.id == "coffee-01").values(mode="replay"))
    cid = comp(engine, "coffee")["id"]
    response = client.post(f"/api/v1/compartments/{cid}/refill/start")
    assert response.status_code == 409 and "replay" in response.json()["detail"]
