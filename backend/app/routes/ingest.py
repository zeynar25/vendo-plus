"""POST /api/v1/readings: the endpoint the Wokwi kits call every 5 seconds."""

import logging
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import Engine

from app.db import utcnow
from app.deps import get_engine
from app.schemas import BatchAccepted, BatchIn
from app.services.ingest import (BadDeviceKey, DuplicateBatch, UnknownCompartment, UnknownMachine,
                                 store_batch)
from app.services.urgency import evaluate_and_log

router = APIRouter(prefix="/api/v1", tags=["kits"])
log = logging.getLogger("vendoplus")


@router.post("/readings", status_code=201, response_model=BatchAccepted)
def post_readings(batch: BatchIn, request: Request, engine: Engine = Depends(get_engine),
                  x_device_key: str | None = Header(default=None)) -> BatchAccepted:
    received_at = utcnow()
    try:
        with engine.begin() as conn:
            stored = store_batch(conn, batch, x_device_key, received_at=received_at)
    except UnknownMachine:
        raise HTTPException(status_code=404, detail="unknown machine_id") from None
    except BadDeviceKey:
        raise HTTPException(status_code=401, detail="missing or wrong device key") from None
    except DuplicateBatch:
        raise HTTPException(status_code=409, detail="duplicate batch") from None
    except UnknownCompartment as exc:
        raise HTTPException(status_code=422, detail=f"unknown compartment: {exc}") from None

    # Urgency runs in its own transaction, so a failure there never loses the stored readings.
    # During replay mode the kit's readings are stored but do not drive urgency.
    if stored.machine["mode"] == "live":
        settings, model = request.app.state.settings, request.app.state.model
        tz = ZoneInfo(stored.machine["timezone"])
        try:
            with engine.begin() as conn:
                for comp in stored.compartments:
                    evaluate_and_log(conn, comp, tz, model, made_at=received_at,
                                     interval_s=settings.prediction_log_interval_s)
        except Exception:  # noqa: BLE001
            log.exception("urgency evaluation failed for batch %s", stored.batch_id)
    return BatchAccepted(batch_id=stored.batch_id, accepted=len(stored.reading_ids),
                         machine_mode=stored.machine["mode"])
