"""Read endpoints for the operator dashboard."""

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import Engine

from app.db import utcnow
from app.deps import get_engine
from app.services.dashboard import build_status, compartment_detail

router = APIRouter(prefix="/api/v1", tags=["dashboard"])


@router.get("/status")
def get_status(request: Request, engine: Engine = Depends(get_engine)) -> dict:
    """Overview polled every 2 s: machines, freshness, and compartments ranked by urgency."""
    with engine.connect() as conn:
        return build_status(conn, request.app.state.model, request.app.state.settings, utcnow())


@router.get("/compartments/{compartment_id}")
def get_compartment(compartment_id: int, request: Request, engine: Engine = Depends(get_engine)) -> dict:
    """Detail view: last 24 h of readings, consumption rate, calibration version, recent urgency."""
    with engine.connect() as conn:
        detail = compartment_detail(conn, compartment_id, request.app.state.model,
                                    request.app.state.settings, utcnow())
    if detail is None:
        raise HTTPException(status_code=404, detail="unknown compartment")
    return detail
