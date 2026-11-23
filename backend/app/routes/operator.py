"""Operator actions from the dashboard: refill mode, reconciling, acknowledging alerts."""

from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import Engine

from app.db import utcnow
from app.deps import get_engine, require_operator
from app.services import refills

router = APIRouter(prefix="/api/v1", tags=["operator"])


def run(engine: Engine, action: Callable, *args):
    try:
        with engine.begin() as conn:
            return action(conn, *args)
    except refills.NotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    except refills.Conflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None


@router.get("/compartments/{compartment_id}/refills")
def get_refills(compartment_id: int, engine: Engine = Depends(get_engine)) -> dict:
    """Past refills, plus detected refills that still need reconciling."""
    return run(engine, refills.refill_history, compartment_id)


@router.post("/compartments/{compartment_id}/refill/start", dependencies=[Depends(require_operator)])
def start_refill(compartment_id: int, engine: Engine = Depends(get_engine)) -> dict:
    return run(engine, refills.start_refill, compartment_id, utcnow())


@router.post("/compartments/{compartment_id}/refill/end", dependencies=[Depends(require_operator)])
def end_refill(compartment_id: int, engine: Engine = Depends(get_engine)) -> dict:
    return run(engine, refills.end_refill, compartment_id, utcnow())


@router.post("/compartments/{compartment_id}/refill/cancel", dependencies=[Depends(require_operator)])
def cancel_refill(compartment_id: int, engine: Engine = Depends(get_engine)) -> dict:
    return run(engine, refills.cancel_refill, compartment_id, utcnow())


@router.post("/compartments/{compartment_id}/acknowledge", dependencies=[Depends(require_operator)])
def acknowledge(compartment_id: int, request: Request, engine: Engine = Depends(get_engine)) -> dict:
    return run(engine, refills.acknowledge, compartment_id, request.app.state.model, utcnow())


@router.post("/history-resets/{reset_id}/reconcile", dependencies=[Depends(require_operator)])
def reconcile(reset_id: int, engine: Engine = Depends(get_engine)) -> dict:
    return run(engine, refills.reconcile, reset_id, utcnow())
