"""Replay mode controls (coffee machine only)."""

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import Engine

from app.db import utcnow
from app.deps import get_engine, require_operator
from app.schemas import ReplayStart
from app.services import replay
from app.services.refills import Conflict, NotFound

router = APIRouter(prefix="/api/v1/machines", tags=["replay"], dependencies=[Depends(require_operator)])


def errors(exc: Exception) -> HTTPException:
    if isinstance(exc, NotFound):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, Conflict):
        return HTTPException(status_code=409, detail=str(exc))
    return HTTPException(status_code=422, detail=str(exc))


@router.post("/{machine_id}/replay/start")
def start(machine_id: str, body: ReplayStart, request: Request, engine: Engine = Depends(get_engine)) -> dict:
    settings = request.app.state.settings
    try:
        with engine.begin() as conn:
            return replay.start_replay(conn, machine_id, body.source_start, body.initial_stock_g, body.speed,
                                       body.noise_sd_g, request.app.state.model, utcnow(),
                                       settings.prediction_log_interval_s)
    except (NotFound, Conflict, replay.InvalidReplay) as exc:
        raise errors(exc) from None


@router.post("/{machine_id}/replay/stop")
def stop(machine_id: str, engine: Engine = Depends(get_engine)) -> dict:
    try:
        with engine.begin() as conn:
            return replay.stop_replay(conn, machine_id, utcnow())
    except (NotFound, Conflict) as exc:
        raise errors(exc) from None
