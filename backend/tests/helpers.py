"""Helpers shared by the tests: seed rows and a day of noise-free history from the parity fixture."""

import json
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import select

from app import tables
from app.cli import hash_key
from app.config import BACKEND_DIR
from app.db import utcnow
from app.ml.model import load_model

TZ = ZoneInfo("Asia/Manila")
CASE = json.loads((Path(__file__).parent / "fixtures" / "feature_parity_cases.json").read_text())[0]
MODEL = load_model(BACKEND_DIR / "model")


def comp(engine, code):
    with engine.connect() as conn:
        return dict(conn.execute(select(tables.compartments).where(tables.compartments.c.code == code)).mappings().one())


def add(engine, comp_id, rows, calibration=1):
    """rows: (t, value, status) tuples, stored as live readings."""
    with engine.begin() as conn:
        for t, value, status in rows:
            conn.execute(tables.readings.insert().values(
                compartment_id=comp_id, t=t, received_at=t, value=value, status=status,
                calibration_version=calibration))


def day_of_history(stock_end=100.0, hours=25):
    """5-minute readings that end at the fixture's decision time with no noise."""
    t = datetime.fromisoformat(CASE["decision_time"]).replace(tzinfo=TZ)
    sales = [(datetime.fromisoformat(s).replace(tzinfo=TZ), g) for s, g in CASE["sales"]]
    rows = []
    for k in range(hours * 12, -1, -1):
        tau = t - timedelta(minutes=5 * k)
        rows.append((tau, stock_end + sum(g for when, g in sales if tau < when <= t), "ok"))
    return rows


# The snack and drink machine that earlier versions seeded. It is no longer part of the
# project; tests use it only to check that a database which still holds it keeps working
# and that `remove-machine` deletes it.
LEGACY_SNACK = {
    "id": "snack-01", "name": "Snack and drink machine", "kind": "snack",
    "compartments": [
        {"code": "row-a", "name": "Coil row 1", "sensor": "ultrasonic", "unit": "items",
         "capacity": 10.0, "hopper_type": None, "position": 1},
        {"code": "row-b", "name": "Coil row 2", "sensor": "ultrasonic", "unit": "items",
         "capacity": 10.0, "hopper_type": None, "position": 2},
    ],
}


def add_legacy_machine(engine, key="legacy-key"):
    """Insert the old snack machine as an earlier seed would have. Returns its device key."""
    with engine.begin() as conn:
        conn.execute(tables.machines.insert().values(
            id=LEGACY_SNACK["id"], name=LEGACY_SNACK["name"], kind=LEGACY_SNACK["kind"], timezone="Asia/Manila",
            device_key_hash=hash_key(key), mode="live", created_at=utcnow()))
        for c in LEGACY_SNACK["compartments"]:
            conn.execute(tables.compartments.insert().values(machine_id=LEGACY_SNACK["id"], **c))
    return key
