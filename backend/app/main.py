"""FastAPI application entry point (Render runs: uvicorn app.main:app)."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.config import Settings
from app.db import create_db_engine, init_db


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine = create_db_engine(settings.database_url)
        if settings.auto_create_tables:
            init_db(engine)
        app.state.engine = engine
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

    return app


app = create_app()
