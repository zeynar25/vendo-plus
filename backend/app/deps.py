"""Shared FastAPI dependencies."""

import hmac

from fastapi import Header, HTTPException, Request
from sqlalchemy import Engine

from app.config import Settings


def get_engine(request: Request) -> Engine:
    return request.app.state.engine


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def require_operator(request: Request, x_operator_key: str | None = Header(default=None)) -> None:
    """Operator actions need X-Operator-Key only when OPERATOR_KEY is set on the server."""
    expected = request.app.state.settings.operator_key
    if expected and not (x_operator_key and hmac.compare_digest(x_operator_key, expected)):
        raise HTTPException(status_code=401, detail="operator key required")
