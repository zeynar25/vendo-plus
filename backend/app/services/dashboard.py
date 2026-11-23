"""What the dashboard reads: the ranked overview and one compartment's detail."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import Connection, select

from app import tables
from app.config import Settings
from app.ml.features import VALID_STATUSES
from app.ml.model import LoadedModel
from app.services.urgency import Urgency, evaluate, run_filter

LABEL_ORDER = {"High": 0, "Medium": 1, "Low": 2, None: 3}
HISTORY_BUCKET = timedelta(minutes=5)


def current_run(conn: Connection, machine: dict) -> dict | None:
    """The running replay run of a machine in replay mode, else None (live)."""
    if machine["mode"] != "replay":
        return None
    rr = tables.replay_runs
    row = conn.execute(select(rr).where(rr.c.machine_id == machine["id"], rr.c.status == "running")
                       .order_by(rr.c.id.desc()).limit(1)).mappings().first()
    return dict(row) if row else None


def is_acknowledged(conn: Connection, comp_id: int, run_id: int | None, label: str | None) -> bool:
    """An acknowledgement hides the alert until the urgency changes."""
    if label not in ("Medium", "High"):
        return False
    a, p = tables.acknowledgements, tables.predictions
    ack = conn.execute(select(a).where(a.c.compartment_id == comp_id, run_filter(a.c.replay_run_id, run_id))
                       .order_by(a.c.acknowledged_at.desc(), a.c.id.desc()).limit(1)).mappings().first()
    if ack is None or ack["label"] != label:
        return False
    changed_since = conn.execute(select(p.c.id).where(
        p.c.compartment_id == comp_id, run_filter(p.c.replay_run_id, run_id),
        p.c.made_at > ack["acknowledged_at"], p.c.label != ack["label"]).limit(1)).first()
    return changed_since is None


def refill_is_open(conn: Connection, comp_id: int) -> bool:
    f = tables.refills
    return conn.execute(select(f.c.id).where(f.c.compartment_id == comp_id, f.c.status == "open")).first() is not None


def pending_unrecorded_refill(conn: Connection, comp_id: int) -> int | None:
    h = tables.history_resets
    row = conn.execute(select(h.c.id).where(h.c.compartment_id == comp_id, h.c.reason == "unrecorded_refill",
                                            h.c.reconciled_at.is_(None), h.c.replay_run_id.is_(None))
                       .order_by(h.c.at.desc()).limit(1)).first()
    return row[0] if row else None


def compartment_state(conn: Connection, comp: dict, run: dict | None, tz: ZoneInfo, model: LoadedModel | None,
                      settings: Settings, now: datetime) -> tuple[dict, Urgency]:
    run_id = run["id"] if run else None
    r = tables.readings
    latest = conn.execute(select(r).where(r.c.compartment_id == comp["id"], run_filter(r.c.replay_run_id, run_id))
                          .order_by(r.c.t.desc(), r.c.id.desc()).limit(1)).mappings().first()
    urgency = evaluate(conn, comp, tz, model, run_id)
    age = (now - latest["received_at"]).total_seconds() if latest else None
    value = latest["value"] if latest else None
    state = {
        "id": comp["id"], "code": comp["code"], "name": comp["name"], "unit": comp["unit"],
        "capacity": comp["capacity"], "value": value,
        "percent": round(100.0 * value / comp["capacity"], 1) if value is not None else None,
        "status": latest["status"] if latest else None,
        "calibration_version": latest["calibration_version"] if latest else None,
        "reading_age_s": round(age, 1) if age is not None else None,
        "stale": age is None or age > settings.stale_after_s,
        "label": urgency.label, "method": urgency.method, "reason": urgency.reason,
        "acknowledged": is_acknowledged(conn, comp["id"], run_id, urgency.label),
        "refill_open": run is None and refill_is_open(conn, comp["id"]),
        # id of a detected refill nobody recorded; the dashboard offers to reconcile it
        "unrecorded_refill_id": None if run else pending_unrecorded_refill(conn, comp["id"]),
    }
    return state, urgency


def machine_state(conn: Connection, machine: dict, model: LoadedModel | None, settings: Settings,
                  now: datetime) -> dict:
    tz = ZoneInfo(machine["timezone"])
    run = current_run(conn, machine)
    comps = conn.execute(select(tables.compartments).where(tables.compartments.c.machine_id == machine["id"])
                         .order_by(tables.compartments.c.position)).mappings().all()
    states = [compartment_state(conn, dict(c), run, tz, model, settings, now)[0] for c in comps]
    valid_ages = [s["reading_age_s"] for s in states if s["reading_age_s"] is not None and s["status"] in VALID_STATUSES]
    last_age = min(valid_ages) if valid_ages else None
    states.sort(key=lambda s: (LABEL_ORDER[s["label"]], s["percent"] if s["percent"] is not None else 101.0))
    replay = None
    if run:
        replay = {"run_id": run["id"], "source_time": run["source_clock"].astimezone(tz).isoformat(),
                  "speed": run["speed"], "started_at": run["started_at"].isoformat()}
    return {
        "id": machine["id"], "name": machine["name"], "kind": machine["kind"], "mode": machine["mode"],
        "online": last_age is not None and last_age <= settings.offline_after_s,
        "last_reading_age_s": last_age, "replay": replay, "compartments": states,
    }


def build_status(conn: Connection, model: LoadedModel | None, settings: Settings, now: datetime) -> dict:
    machines = conn.execute(select(tables.machines).order_by(tables.machines.c.id)).mappings().all()
    return {"server_time": now.isoformat(),
            "machines": [machine_state(conn, dict(m), model, settings, now) for m in machines]}


def compartment_detail(conn: Connection, comp_id: int, model: LoadedModel | None, settings: Settings,
                       now: datetime) -> dict | None:
    comp = conn.execute(select(tables.compartments).where(tables.compartments.c.id == comp_id)).mappings().first()
    if comp is None:
        return None
    comp = dict(comp)
    machine = dict(conn.execute(select(tables.machines).where(tables.machines.c.id == comp["machine_id"]))
                   .mappings().one())
    tz = ZoneInfo(machine["timezone"])
    run = current_run(conn, machine)
    run_id = run["id"] if run else None
    state, urgency = compartment_state(conn, comp, run, tz, model, settings, now)

    # Last 24 hours of the feature clock, one point per 5 minutes (the last valid reading in each).
    r = tables.readings
    history = []
    if urgency.t is not None:
        rows = conn.execute(select(r.c.t, r.c.value).where(
            r.c.compartment_id == comp_id, run_filter(r.c.replay_run_id, run_id),
            r.c.t >= urgency.t - timedelta(hours=24), r.c.status.in_(VALID_STATUSES), r.c.value.is_not(None))
            .order_by(r.c.t)).all()
        buckets: dict[int, tuple] = {}
        for t, value in rows:
            buckets[int(t.timestamp() // HISTORY_BUCKET.total_seconds())] = (t, value)
        history = [{"t": t.astimezone(tz).isoformat(), "value": value} for t, value in buckets.values()]

    rates = None
    if urgency.features:
        cap = comp["capacity"]
        rates = {f"last_{h}h": round(urgency.features[f"rate_{h}h"] * cap, 2) for h in (1, 6, 24)}

    p = tables.predictions
    alerts = conn.execute(select(p.c.made_at, p.c.t, p.c.label, p.c.method, p.c.reason).where(
        p.c.compartment_id == comp_id, run_filter(p.c.replay_run_id, run_id))
        .order_by(p.c.made_at.desc(), p.c.id.desc()).limit(20)).mappings().all()
    return {
        "machine_id": machine["id"], "mode": machine["mode"], "clock": "source" if run else "live",
        "compartment": state,
        "consumption_per_hour": rates,          # grams (or items) per hour; null until the model runs
        "history": history,
        "recent_urgency": [{"made_at": a["made_at"].isoformat(), "t": a["t"].astimezone(tz).isoformat(),
                            "label": a["label"], "method": a["method"], "reason": a["reason"]} for a in alerts],
    }
