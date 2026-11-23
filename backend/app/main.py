"""FastAPI application entry point (Render runs: uvicorn app.main:app)."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.config import Settings
from app.db import create_db_engine, init_db
from app.ml.model import load_model
from app.routes import dashboard, ingest

log = logging.getLogger("vendoplus")


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
        yield
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
    return app


app = create_app()
