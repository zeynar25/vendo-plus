"""Database engine and connection helpers."""

from datetime import UTC, datetime

from sqlalchemy import Engine, create_engine

from app.tables import metadata


def normalize_url(url: str) -> str:
    """Accept the postgres:// or postgresql:// strings Supabase shows and use the psycopg 3 driver."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


def create_db_engine(url: str) -> Engine:
    url = normalize_url(url)
    if url.startswith("sqlite"):
        return create_engine(url, connect_args={"check_same_thread": False})
    # prepare_threshold=None: no server-side prepared statements, so the same code also
    # works through Supabase's transaction pooler. pool_pre_ping survives Render sleeps.
    return create_engine(url, pool_pre_ping=True, pool_size=5, max_overflow=2,
                         connect_args={"prepare_threshold": None})


def init_db(engine: Engine) -> None:
    """Create any missing tables. Existing tables and data are left untouched."""
    metadata.create_all(engine)


def utcnow() -> datetime:
    return datetime.now(UTC)


def as_utc(value: datetime | None) -> datetime | None:
    """SQLite returns naive datetimes; treat them as UTC. Aware values are converted to UTC."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)
