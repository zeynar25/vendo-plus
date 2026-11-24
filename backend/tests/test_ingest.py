import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import tables
from app.main import create_app
from tests.helpers import add_legacy_machine


@pytest.fixture
def client(settings, engine, device_keys):
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def coffee_batch(sequence=1, session="s1", **overrides):
    body = {
        "machine_id": "coffee-01", "session_id": session, "sequence": sequence,
        "device_time": "2026-11-19T06:00:00Z",
        "readings": [
            {"compartment": "coffee", "value": 512.4, "status": "ok", "calibration_version": 1},
            {"compartment": "milk", "value": 300.0, "status": "ok", "calibration_version": 1},
            {"compartment": "chocolate", "value": None, "status": "unavailable", "calibration_version": 1},
        ],
    }
    body.update(overrides)
    return body


def stored_readings(engine):
    with engine.connect() as conn:
        rows = conn.execute(select(tables.readings, tables.compartments.c.code)
                            .join(tables.compartments)).mappings().all()
    return {row["code"]: row for row in rows}


def test_valid_batch_is_stored(client, engine, device_keys):
    response = client.post("/api/v1/readings", json=coffee_batch(),
                           headers={"X-Device-Key": device_keys["coffee-01"]})
    assert response.status_code == 201, response.text
    assert response.json()["accepted"] == 3 and response.json()["machine_mode"] == "live"
    rows = stored_readings(engine)
    assert rows["coffee"]["value"] == pytest.approx(512.4)
    assert rows["chocolate"]["value"] is None and rows["chocolate"]["status"] == "unavailable"


def test_missing_or_wrong_key_is_refused(client, engine, device_keys):
    assert client.post("/api/v1/readings", json=coffee_batch()).status_code == 401
    wrong = {"X-Device-Key": add_legacy_machine(engine)}  # a real key, but for another machine
    assert client.post("/api/v1/readings", json=coffee_batch(), headers=wrong).status_code == 401


def test_unknown_machine_is_404(client, device_keys):
    body = coffee_batch(machine_id="tea-99")
    response = client.post("/api/v1/readings", json=body, headers={"X-Device-Key": "x"})
    assert response.status_code == 404


def test_same_session_and_sequence_is_rejected_once_stored(client, device_keys):
    headers = {"X-Device-Key": device_keys["coffee-01"]}
    assert client.post("/api/v1/readings", json=coffee_batch(7), headers=headers).status_code == 201
    assert client.post("/api/v1/readings", json=coffee_batch(7), headers=headers).status_code == 409
    # after a reboot the kit uses a new session id, so sequence 7 is accepted again
    assert client.post("/api/v1/readings", json=coffee_batch(7, session="s2"), headers=headers).status_code == 201


def test_unknown_or_repeated_compartment_is_422(client, device_keys):
    headers = {"X-Device-Key": device_keys["coffee-01"]}
    unknown = coffee_batch(readings=[{"compartment": "sugar", "value": 1, "status": "ok", "calibration_version": 1}])
    assert client.post("/api/v1/readings", json=unknown, headers=headers).status_code == 422
    twice = coffee_batch(readings=[{"compartment": "milk", "value": 1, "status": "ok", "calibration_version": 1}] * 2)
    assert client.post("/api/v1/readings", json=twice, headers=headers).status_code == 422


def test_ok_without_a_value_is_422(client, device_keys):
    body = coffee_batch(readings=[{"compartment": "milk", "value": None, "status": "ok", "calibration_version": 1}])
    response = client.post("/api/v1/readings", json=body, headers={"X-Device-Key": device_keys["coffee-01"]})
    assert response.status_code == 422


@pytest.mark.parametrize("sent, expected", [
    ((-4.0, "ok"), ("corrected_zero", 0.0)),        # -10 to 0 g is shown as 0 with a flag
    ((-30.0, "ok"), ("out_of_range", None)),        # below -10 g is rejected
    ((1020.0, "ok"), ("over_capacity", 1020.0)),    # above capacity: stored, never used
    ((1200.0, "ok"), ("out_of_range", None)),       # above 1,050 g is rejected
    ((250.0, "unavailable"), ("unavailable", None)),  # an invalid reading is never a number
])
def test_backend_rechecks_hopper_ranges(client, engine, device_keys, sent, expected):
    value, status = sent
    body = coffee_batch(readings=[{"compartment": "coffee", "value": value, "status": status,
                                   "calibration_version": 1}])
    assert client.post("/api/v1/readings", json=body,
                       headers={"X-Device-Key": device_keys["coffee-01"]}).status_code == 201
    row = stored_readings(engine)["coffee"]
    assert (row["status"], row["value"]) == expected


def test_a_leftover_coil_row_still_stores_whole_items(client, engine, device_keys):
    key = add_legacy_machine(engine)
    body = {"machine_id": "snack-01", "session_id": "k", "sequence": 0,
            "readings": [{"compartment": "row-a", "value": 6.6, "status": "ok", "calibration_version": 1},
                         {"compartment": "row-b", "value": 12, "status": "ok", "calibration_version": 1}]}
    assert client.post("/api/v1/readings", json=body,
                       headers={"X-Device-Key": key}).status_code == 201
    rows = stored_readings(engine)
    assert rows["row-a"]["value"] == 7.0 and rows["row-a"]["status"] == "ok"
    assert rows["row-b"]["status"] == "over_capacity"
