"""Helpers shared by the tests: seed rows and a day of noise-free history from the parity fixture."""

import json
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import select

from app import tables
from app.config import BACKEND_DIR
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
