"""FastAPI application entry point (Render runs: uvicorn app.main:app)."""

import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.config import Settings
from app.db import create_db_engine, init_db, utcnow
from app.ml.model import load_model
from app.routes import dashboard, ingest, operator, replay as replay_routes
from app.services import replay

log = logging.getLogger("vendoplus")


def replay_ticks(app: FastAPI) -> None:
    """Advance every running replay by one tick (runs in a worker thread)."""
    settings = app.state.settings
    with app.state.engine.begin() as conn:
        for run in replay.running_runs(conn):
            replay.tick(conn, run, settings.replay_tick_s, app.state.model, utcnow(),
                        settings.prediction_log_interval_s)


async def replay_loop(app: FastAPI) -> None:
    while True:
        await asyncio.sleep(app.state.settings.replay_tick_s)
        try:
            await asyncio.to_thread(replay_ticks, app)
        except Exception:  # noqa: BLE001 - keep the loop alive
            log.exception("replay tick failed")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine = create_db_engine(settings.database_url)
        if settings.auto_create_tables:
            init_db(engine)
        app.state.engine = engine
        # A model that fails its integrity check is not used; the service still runs and
        # shows the basic stock warning, and /api/v1/system/check reports the error.
        app.state.model, app.state.model_error = None, None
        try:
            app.state.model = load_model(settings.model_dir)
        except Exception as exc:  # noqa: BLE001 - any failure must leave the API up
            app.state.model_error = f"{type(exc).__name__}: {exc}"
            log.error("Model not loaded: %s", app.state.model_error)
        # Running replays continue after a restart (for example after Render wakes the service).
        runner = asyncio.create_task(replay_loop(app)) if settings.enable_replay_runner else None
        yield
        if runner:
            runner.cancel()
            with suppress(asyncio.CancelledError):
                await runner
        engine.dispose()

    app = FastAPI(title="Vendo+ backend", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origin_list,
                       allow_methods=["*"], allow_headers=["*"])

    @app.get("/healthz", tags=["system"])
    def healthz() -> dict:
        """Liveness check for Render. Touches nothing else, so it answers even if the database is down."""
        return {"status": "ok", "version": __version__}

    app.include_router(ingest.router)
    app.include_router(dashboard.router)
    app.include_router(operator.router)
    app.include_router(replay_routes.router)
    return app


app = create_app()
