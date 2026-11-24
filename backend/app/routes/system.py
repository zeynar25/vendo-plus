"""Pre-demo check: database, model, and the latest value on every channel."""

from fastapi import APIRouter, Request
from sqlalchemy import select, text

from app import __version__, tables
from app.db import utcnow
from app.services.dashboard import machine_state

router = APIRouter(prefix="/api/v1/system", tags=["system"])


@router.get("/check")
def system_check(request: Request) -> dict:
    """Before each demonstration: is the database reachable, is the model the selected one, and does
    every channel report? Compare each channel's value with the reference weight or distance set in Wokwi."""
    state, settings, now = request.app.state, request.app.state.settings, utcnow()
    result = {"server_time": now.isoformat(), "version": __version__}

    model = state.model
    result["model"] = {
        "loaded": model is not None, "error": state.model_error,
        "algorithm": model.algorithm if model else None, "sha256": model.sha256 if model else None,
        "scikit_learn": model.sklearn_version if model else None,
    }
    try:
        with state.engine.connect() as conn:
            conn.execute(text("SELECT 1"))
            machines = conn.execute(select(tables.machines).order_by(tables.machines.c.id)).mappings().all()
            result["machines"] = []
            for machine in machines:
                ms = machine_state(conn, dict(machine), model, settings, now)
                result["machines"].append({
                    "id": ms["id"], "mode": ms["mode"], "online": ms["online"],
                    "channels": [{k: c[k] for k in ("code", "value", "unit", "status", "reading_age_s",
                                                    "calibration_version")} for c in ms["compartments"]],
                })
            events = conn.execute(select(tables.service_events).order_by(tables.service_events.c.at.desc())
                                  .limit(10)).mappings().all()
            result["service_events"] = [{"kind": e["kind"], "at": e["at"].isoformat(), "detail": e["detail"]}
                                        for e in events]
        result["database"] = {"ok": True, "error": None}
    except Exception as exc:  # noqa: BLE001 - report, never crash the check
        result["database"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        result.setdefault("machines", [])
        result.setdefault("service_events", [])
    result["ready"] = result["database"]["ok"] and model is not None
    return result
