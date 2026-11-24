"""Refill mode, unrecorded refills, and alert acknowledgement.

Stable = three consecutive valid reports within 5 g. A rise of more than 20 g outside
refill mode is an unrecorded refill: it starts a new 24-hour history until an operator
reconciles it. (The item-count rules below apply only to a coil row of the removed snack
machine, if an old database still holds it.)
"""

from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import Connection, select

from app import tables
from app.ml.features import VALID_STATUSES
from app.ml.model import LoadedModel
from app.services.dashboard import current_run
from app.services.urgency import evaluate

STABLE_COUNT = 3
STABLE_SPREAD_G = 5.0
UNRECORDED_JUMP_G = 20.0
UNRECORDED_JUMP_ITEMS = 1.0


class Conflict(Exception):
    """The action does not fit the current state (409)."""


class NotStable(Conflict):
    pass


class NotFound(Exception):
    pass


def is_hopper(comp: dict) -> bool:
    return comp["unit"] == "g"


def jump_is_unrecorded(comp: dict, jump: float) -> bool:
    return jump > UNRECORDED_JUMP_G if is_hopper(comp) else jump >= UNRECORDED_JUMP_ITEMS


def get_compartment(conn: Connection, comp_id: int) -> tuple[dict, dict]:
    comp = conn.execute(select(tables.compartments).where(tables.compartments.c.id == comp_id)).mappings().first()
    if comp is None:
        raise NotFound("unknown compartment")
    machine = conn.execute(select(tables.machines).where(tables.machines.c.id == comp["machine_id"])).mappings().one()
    return dict(comp), dict(machine)


def open_refill(conn: Connection, comp_id: int) -> dict | None:
    f = tables.refills
    row = conn.execute(select(f).where(f.c.compartment_id == comp_id, f.c.status == "open")
                       .order_by(f.c.id.desc()).limit(1)).mappings().first()
    return dict(row) if row else None


def stable_value(conn: Connection, comp: dict, since: datetime | None = None) -> float | None:
    """Mean of the last three valid live readings if they agree, else None."""
    r = tables.readings
    query = select(r.c.value).where(r.c.compartment_id == comp["id"], r.c.replay_run_id.is_(None),
                                    r.c.status.in_(VALID_STATUSES), r.c.value.is_not(None))
    if since is not None:
        query = query.where(r.c.received_at >= since)
    values = [row[0] for row in conn.execute(query.order_by(r.c.t.desc(), r.c.id.desc()).limit(STABLE_COUNT))]
    if len(values) < STABLE_COUNT:
        return None
    if is_hopper(comp):
        return sum(values) / len(values) if max(values) - min(values) <= STABLE_SPREAD_G else None
    return values[0] if len(set(values)) == 1 else None


def detect_unrecorded_refill(conn: Connection, comp: dict, t: datetime, value: float | None, status: str) -> bool:
    """Call before storing a live reading. Records a history reset if stock rose outside refill mode."""
    if status not in VALID_STATUSES or value is None or open_refill(conn, comp["id"]) is not None:
        return False
    r = tables.readings
    previous = conn.execute(select(r.c.value).where(
        r.c.compartment_id == comp["id"], r.c.replay_run_id.is_(None), r.c.t < t,
        r.c.status.in_(VALID_STATUSES), r.c.value.is_not(None)).order_by(r.c.t.desc(), r.c.id.desc()).limit(1)).first()
    if previous is None or not jump_is_unrecorded(comp, value - previous[0]):
        return False
    conn.execute(tables.history_resets.insert().values(
        compartment_id=comp["id"], replay_run_id=None, at=t, reason="unrecorded_refill", jump=value - previous[0]))
    return True


def require_live(machine: dict) -> None:
    if machine["mode"] != "live":
        raise Conflict("refill mode is not available during replay")


def start_refill(conn: Connection, comp_id: int, now: datetime) -> dict:
    comp, machine = get_compartment(conn, comp_id)
    require_live(machine)
    if open_refill(conn, comp_id) is not None:
        raise Conflict("a refill is already open")
    before = stable_value(conn, comp)
    if before is None:
        raise NotStable("not stable")
    refill_id = conn.execute(tables.refills.insert().values(
        compartment_id=comp_id, status="open", kind="recorded", started_at=now, before_value=before)
        ).inserted_primary_key[0]
    return {"refill_id": refill_id, "status": "open", "before_value": round(before, 2)}


def end_refill(conn: Connection, comp_id: int, now: datetime) -> dict:
    comp, machine = get_compartment(conn, comp_id)
    refill = open_refill(conn, comp_id)
    if refill is None:
        raise Conflict("no open refill")
    after = stable_value(conn, comp, since=refill["started_at"])
    if after is None:
        raise NotStable("not stable")
    added = max(0.0, after - refill["before_value"])
    conn.execute(tables.refills.update().where(tables.refills.c.id == refill["id"]).values(
        status="closed", ended_at=now, after_value=after, added=added))
    return {"refill_id": refill["id"], "status": "closed", "before_value": round(refill["before_value"], 2),
            "after_value": round(after, 2), "added": round(added, 2)}


def cancel_refill(conn: Connection, comp_id: int, now: datetime) -> dict:
    comp, _ = get_compartment(conn, comp_id)
    refill = open_refill(conn, comp_id)
    if refill is None:
        raise Conflict("no open refill")
    conn.execute(tables.refills.update().where(tables.refills.c.id == refill["id"]).values(
        status="cancelled", ended_at=now))
    # Stock added during a cancelled refill was never recorded, so treat it as unrecorded.
    r = tables.readings
    latest = conn.execute(select(r.c.t, r.c.value).where(
        r.c.compartment_id == comp_id, r.c.replay_run_id.is_(None), r.c.status.in_(VALID_STATUSES),
        r.c.value.is_not(None)).order_by(r.c.t.desc(), r.c.id.desc()).limit(1)).mappings().first()
    reset = False
    if latest is not None and jump_is_unrecorded(comp, latest["value"] - refill["before_value"]):
        conn.execute(tables.history_resets.insert().values(
            compartment_id=comp_id, at=latest["t"], reason="unrecorded_refill",
            jump=latest["value"] - refill["before_value"]))
        reset = True
    return {"refill_id": refill["id"], "status": "cancelled", "history_reset": reset}


def reconcile(conn: Connection, reset_id: int, now: datetime) -> dict:
    h = tables.history_resets
    reset = conn.execute(select(h).where(h.c.id == reset_id)).mappings().first()
    if reset is None:
        raise NotFound("unknown history reset")
    if reset["reason"] != "unrecorded_refill" or reset["reconciled_at"] is not None:
        raise Conflict("only an open unrecorded refill can be reconciled")
    refill_id = conn.execute(tables.refills.insert().values(
        compartment_id=reset["compartment_id"], status="closed", kind="reconciled", started_at=reset["at"],
        ended_at=reset["at"], added=reset["jump"])).inserted_primary_key[0]
    conn.execute(h.update().where(h.c.id == reset_id).values(reconciled_at=now, refill_id=refill_id))
    return {"history_reset_id": reset_id, "refill_id": refill_id, "added": round(reset["jump"], 2)}


def acknowledge(conn: Connection, comp_id: int, model: LoadedModel | None, now: datetime) -> dict:
    comp, machine = get_compartment(conn, comp_id)
    run = current_run(conn, machine)
    run_id = run["id"] if run else None
    urgency = evaluate(conn, comp, ZoneInfo(machine["timezone"]), model, run_id)
    if urgency.label not in ("Medium", "High"):
        raise Conflict("nothing to acknowledge")
    conn.execute(tables.acknowledgements.insert().values(
        compartment_id=comp_id, replay_run_id=run_id, label=urgency.label, acknowledged_at=now))
    return {"compartment_id": comp_id, "acknowledged_label": urgency.label}


def refill_history(conn: Connection, comp_id: int) -> dict:
    get_compartment(conn, comp_id)
    f, h = tables.refills, tables.history_resets
    refills = conn.execute(select(f).where(f.c.compartment_id == comp_id)
                           .order_by(f.c.started_at.desc(), f.c.id.desc()).limit(50)).mappings().all()
    pending = conn.execute(select(h).where(h.c.compartment_id == comp_id, h.c.reason == "unrecorded_refill",
                                           h.c.reconciled_at.is_(None), h.c.replay_run_id.is_(None))
                           .order_by(h.c.at.desc())).mappings().all()
    iso = lambda v: v.isoformat() if v is not None else None  # noqa: E731
    return {
        "refills": [{"id": x["id"], "status": x["status"], "kind": x["kind"], "started_at": iso(x["started_at"]),
                     "ended_at": iso(x["ended_at"]), "before_value": x["before_value"],
                     "after_value": x["after_value"], "added": x["added"]} for x in refills],
        "unrecorded_refills": [{"history_reset_id": x["id"], "at": iso(x["at"]), "jump": x["jump"]} for x in pending],
    }
