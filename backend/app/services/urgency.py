"""Decide each compartment's urgency: the model when allowed, otherwise the basic stock warning.

Basic stock warning = the stock-only baseline of the paper: High at or below 5% of
capacity, Medium at or below 20%, Low above. Coil rows always get it, because the
model was trained and evaluated on the coffee hoppers only.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import Connection, func, or_, select

from app import tables
from app.db import as_utc
from app.ml.features import MAX_BOUNDARY_GAP, VALID_STATUSES, WINDOWS_H, Reading, RefillSpan, compute_features
from app.ml.model import LoadedModel

BASIC_HIGH_MAX = 0.05
BASIC_MEDIUM_MAX = 0.20
LOOKBACK = timedelta(hours=24) + MAX_BOUNDARY_GAP


@dataclass(frozen=True)
class Urgency:
    label: str | None           # Low | Medium | High; None without a valid reading or while refilling
    method: str | None          # model | basic
    reason: str | None          # why basic was used, or why there is no label
    t: datetime | None          # feature clock of the reading it is based on
    value: float | None
    features: dict | None = None
    model_version: str | None = None


def basic_label(value: float, capacity: float) -> str:
    ratio = value / capacity
    if ratio <= BASIC_HIGH_MAX:
        return "High"
    if ratio <= BASIC_MEDIUM_MAX:
        return "Medium"
    return "Low"


def run_filter(column, run_id: int | None):
    return column.is_(None) if run_id is None else column == run_id


def latest_reading(conn: Connection, compartment_id: int, run_id: int | None):
    r = tables.readings
    return conn.execute(select(r).where(r.c.compartment_id == compartment_id, run_filter(r.c.replay_run_id, run_id))
                        .order_by(r.c.t.desc(), r.c.id.desc()).limit(1)).mappings().first()


def open_refill(conn: Connection, compartment_id: int):
    f = tables.refills
    return conn.execute(select(f).where(f.c.compartment_id == compartment_id, f.c.status == "open")
                        .order_by(f.c.id.desc()).limit(1)).mappings().first()


def history_start(conn: Connection, comp_id: int, run_id: int | None, current) -> tuple[datetime | None, bool]:
    """The earliest usable time: after the last calibration change or unreconciled reset."""
    r, h = tables.readings, tables.history_resets
    since = current["t"] - LOOKBACK
    starts = []
    other_cal = conn.execute(select(func.max(r.c.t)).where(
        r.c.compartment_id == comp_id, run_filter(r.c.replay_run_id, run_id), r.c.t >= since,
        r.c.calibration_version.is_not(None), r.c.calibration_version != current["calibration_version"])).scalar()
    if other_cal is not None and current["calibration_version"] is not None:
        starts.append(as_utc(other_cal) + timedelta(microseconds=1))
    reset_at = conn.execute(select(func.max(h.c.at)).where(
        h.c.compartment_id == comp_id, run_filter(h.c.replay_run_id, run_id), h.c.reconciled_at.is_(None),
        h.c.at >= since)).scalar()
    if reset_at is not None:
        starts.append(as_utc(reset_at))
    return (max(starts) if starts else None), bool(starts)


def window_anchors(conn: Connection, comp_id: int, run_id: int | None, t: datetime,
                   start_from: datetime | None) -> list[Reading]:
    """For each window, the latest valid reading at or before its start (inside the usable history)."""
    r = tables.readings
    anchors = []
    for hours in sorted(WINDOWS_H, reverse=True):
        boundary = t - timedelta(hours=hours)
        query = select(r.c.t, r.c.value, r.c.status).where(
            r.c.compartment_id == comp_id, run_filter(r.c.replay_run_id, run_id), r.c.t <= boundary,
            r.c.status.in_(VALID_STATUSES), r.c.value.is_not(None))
        if start_from is not None:
            query = query.where(r.c.t >= start_from)
        row = conn.execute(query.order_by(r.c.t.desc()).limit(1)).mappings().first()
        if row is not None:
            anchors.append(Reading(t=as_utc(row["t"]), value=row["value"], status=row["status"]))
    return sorted(set(anchors), key=lambda a: a.t)


def refill_spans(conn: Connection, comp_id: int, t: datetime) -> list[RefillSpan]:
    f = tables.refills
    rows = conn.execute(select(f).where(
        f.c.compartment_id == comp_id, f.c.status.in_(["open", "closed"]),
        or_(f.c.ended_at.is_(None), f.c.ended_at >= t - LOOKBACK))).mappings().all()
    return [RefillSpan(started_at=as_utc(x["started_at"]), ended_at=as_utc(x["ended_at"]),
                       added=x["added"] or 0.0) for x in rows]


def evaluate(conn: Connection, comp: dict, tz: ZoneInfo, model: LoadedModel | None,
             run_id: int | None = None) -> Urgency:
    current = latest_reading(conn, comp["id"], run_id)
    if current is None:
        return Urgency(None, None, "no_reading", None, None)
    t = as_utc(current["t"])
    current = {**current, "t": t}
    if current["status"] not in VALID_STATUSES or current["value"] is None:
        return Urgency(None, None, "invalid_reading", t, None)
    value = current["value"]
    if run_id is None and open_refill(conn, comp["id"]) is not None:
        return Urgency(None, None, "refill_open", t, value)
    if comp["sensor"] != "load_cell" or comp["hopper_type"] is None:
        return Urgency(basic_label(value, comp["capacity"]), "basic", "coil_row", t, value)

    start_from, reset_active = history_start(conn, comp["id"], run_id, current)
    anchors = window_anchors(conn, comp["id"], run_id, t, start_from)
    spans = refill_spans(conn, comp["id"], t) if run_id is None else []
    result = compute_features(anchors + [Reading(t=t, value=value, status=current["status"])], spans,
                              capacity=comp["capacity"], hopper_type=comp["hopper_type"], tz=tz,
                              history_start=start_from, reset_active=reset_active)
    if result.features is None:
        return Urgency(basic_label(value, comp["capacity"]), "basic", result.reason, t, value)
    if model is None:
        return Urgency(basic_label(value, comp["capacity"]), "basic", "model_unavailable", t, value)
    return Urgency(model.predict(result.features), "model", None, t, value, result.features, model.sha256)


def log_prediction(conn: Connection, comp_id: int, urgency: Urgency, made_at: datetime,
                   interval_s: float, run_id: int | None = None) -> bool:
    """Store a row when the urgency changes, and at least every interval_s. Returns True if stored."""
    if urgency.label is None:
        return False
    p = tables.predictions
    last = conn.execute(select(p.c.label, p.c.method, p.c.reason, p.c.made_at).where(
        p.c.compartment_id == comp_id, run_filter(p.c.replay_run_id, run_id))
        .order_by(p.c.made_at.desc(), p.c.id.desc()).limit(1)).first()
    changed = last is None or (last.label, last.method, last.reason) != (urgency.label, urgency.method, urgency.reason)
    due = last is not None and (made_at - as_utc(last.made_at)).total_seconds() >= interval_s
    if not (changed or due):
        return False
    conn.execute(p.insert().values(
        compartment_id=comp_id, replay_run_id=run_id, t=urgency.t, made_at=made_at, label=urgency.label,
        method=urgency.method, reason=urgency.reason, model_version=urgency.model_version,
        features=urgency.features))
    return True


def latest_prediction(conn: Connection, comp_id: int, run_id: int | None):
    p = tables.predictions
    return conn.execute(select(p).where(p.c.compartment_id == comp_id, run_filter(p.c.replay_run_id, run_id))
                        .order_by(p.c.made_at.desc(), p.c.id.desc()).limit(1)).mappings().first()


def evaluate_and_log(conn: Connection, comp: dict, tz: ZoneInfo, model: LoadedModel | None, made_at: datetime,
                     interval_s: float, run_id: int | None = None) -> Urgency:
    urgency = evaluate(conn, comp, tz, model, run_id)
    log_prediction(conn, comp["id"], urgency, made_at, interval_s, run_id)
    return urgency

