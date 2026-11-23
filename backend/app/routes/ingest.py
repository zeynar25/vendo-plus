"""POST /api/v1/readings: the endpoint the Wokwi kits call every 5 seconds."""

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import Engine

from app.db import utcnow
from app.deps import get_engine
from app.schemas import BatchAccepted, BatchIn
from app.services.ingest import (BadDeviceKey, DuplicateBatch, UnknownCompartment, UnknownMachine,
                                 store_batch)

router = APIRouter(prefix="/api/v1", tags=["kits"])


@router.post("/readings", status_code=201, response_model=BatchAccepted)
def post_readings(batch: BatchIn, engine: Engine = Depends(get_engine),
                  x_device_key: str | None = Header(default=None)) -> BatchAccepted:
    try:
        with engine.begin() as conn:
            stored = store_batch(conn, batch, x_device_key, received_at=utcnow())
    except UnknownMachine:
        raise HTTPException(status_code=404, detail="unknown machine_id") from None
    except BadDeviceKey:
        raise HTTPException(status_code=401, detail="missing or wrong device key") from None
    except DuplicateBatch:
        raise HTTPException(status_code=409, detail="duplicate batch") from None
    except UnknownCompartment as exc:
        raise HTTPException(status_code=422, detail=f"unknown compartment: {exc}") from None
    return BatchAccepted(batch_id=stored.batch_id, accepted=len(stored.reading_ids),
                         machine_mode=stored.machine["mode"])
