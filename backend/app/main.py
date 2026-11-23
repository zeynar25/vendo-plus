"""FastAPI application entry point (Render runs: uvicorn app.main:app)."""

from fastapi import FastAPI

from app import __version__


def create_app() -> FastAPI:
    app = FastAPI(title="Vendo+ backend", version=__version__)

    @app.get("/healthz", tags=["system"])
    def healthz() -> dict:
        """Liveness check for Render. Touches nothing else, so it answers even if the database is down."""
        return {"status": "ok", "version": __version__}

    return app


app = create_app()
