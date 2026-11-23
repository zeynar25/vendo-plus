from sqlalchemy import func, select

from app import tables
from app.cli import hash_key, seed
from app.db import as_utc, normalize_url


def test_supabase_urls_use_psycopg_driver():
    assert normalize_url("postgresql://u:p@h:5432/db") == "postgresql+psycopg://u:p@h:5432/db"
    assert normalize_url("postgres://u:p@h:5432/db") == "postgresql+psycopg://u:p@h:5432/db"
    assert normalize_url("sqlite:///x.db") == "sqlite:///x.db"


def test_seed_creates_two_machines_and_six_compartments(engine, settings):
    keys = seed(engine, settings.timezone)
    assert set(keys) == {"coffee-01", "snack-01"}
    with engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(tables.machines)).scalar() == 2
        assert conn.execute(select(func.count()).select_from(tables.compartments)).scalar() == 6
        stored = conn.execute(select(tables.machines.c.device_key_hash)
                              .where(tables.machines.c.id == "coffee-01")).scalar()
    assert stored == hash_key(keys["coffee-01"])   # only the hash is stored
    assert stored != keys["coffee-01"]


def test_seed_is_idempotent_and_rotation_replaces_keys(engine, settings):
    first = seed(engine, settings.timezone)
    assert seed(engine, settings.timezone) == {}            # nothing new, no keys printed
    rotated = seed(engine, settings.timezone, rotate_keys=True)
    assert rotated["coffee-01"] != first["coffee-01"]
    with engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(tables.compartments)).scalar() == 6


def test_naive_datetimes_are_read_as_utc():
    from datetime import datetime
    assert as_utc(datetime(2026, 1, 1, 8, 0)).utcoffset().total_seconds() == 0
