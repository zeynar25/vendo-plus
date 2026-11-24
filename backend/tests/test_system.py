import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import tables
from app.main import create_app


@pytest.fixture
def client(settings, engine, device_keys):
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def test_check_reports_database_model_and_every_channel(client, device_keys):
    body = {"machine_id": "coffee-01", "session_id": "s", "sequence": 1,
            "readings": [{"compartment": "coffee", "value": 500.2, "status": "ok", "calibration_version": 1}]}
    client.post("/api/v1/readings", json=body, headers={"X-Device-Key": device_keys["coffee-01"]})
    check = client.get("/api/v1/system/check").json()
    assert check["ready"] is True and check["database"]["ok"] is True
    assert check["model"]["algorithm"] == "random_forest" and check["model"]["sha256"].startswith("768aaa18")
    coffee = next(m for m in check["machines"] if m["id"] == "coffee-01")
    channel = next(c for c in coffee["channels"] if c["code"] == "coffee")
    assert channel["value"] == pytest.approx(500.2) and channel["calibration_version"] == 1
    assert len(coffee["channels"]) == 3


def test_check_is_not_ready_without_the_model(settings, engine, device_keys, tmp_path):
    with TestClient(create_app(settings.model_copy(update={"model_dir": tmp_path}))) as client:
        check = client.get("/api/v1/system/check").json()
    assert check["ready"] is False and check["model"]["loaded"] is False and check["model"]["error"]


def test_startup_and_first_request_are_recorded_for_cold_start_timing(client, engine):
    client.get("/healthz")                          # Render's health check does not count
    response = client.get("/api/v1/status")
    assert response.headers["Server-Timing"].startswith("app;dur=")
    client.get("/api/v1/status")                    # only the first request is recorded
    with engine.connect() as conn:
        events = conn.execute(select(tables.service_events.c.kind, tables.service_events.c.detail)
                              .order_by(tables.service_events.c.id)).all()
    assert [e.kind for e in events] == ["startup", "first_request"]
    assert events[1].detail["path"] == "/api/v1/status"
    assert events[1].detail["seconds_after_startup"] >= 0
