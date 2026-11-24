import pytest
from sqlalchemy import func, select

from app import tables
from app.cli import hash_key, remove_machine, seed
from app.db import as_utc, normalize_url, utcnow
from tests.helpers import add_legacy_machine


def test_supabase_urls_use_psycopg_driver():
    assert normalize_url("postgresql://u:p@h:5432/db") == "postgresql+psycopg://u:p@h:5432/db"
    assert normalize_url("postgres://u:p@h:5432/db") == "postgresql+psycopg://u:p@h:5432/db"
    assert normalize_url("sqlite:///x.db") == "sqlite:///x.db"


def test_seed_creates_the_coffee_machine_and_its_three_hoppers(engine, settings):
    keys = seed(engine, settings.timezone)
    assert set(keys) == {"coffee-01"}
    with engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(tables.machines)).scalar() == 1
        assert conn.execute(select(func.count()).select_from(tables.compartments)).scalar() == 3
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
        assert conn.execute(select(func.count()).select_from(tables.compartments)).scalar() == 3


def test_naive_datetimes_are_read_as_utc():
    from datetime import datetime
    assert as_utc(datetime(2026, 1, 1, 8, 0)).utcoffset().total_seconds() == 0


def test_remove_machine_deletes_a_leftover_machine_and_keeps_the_coffee_machine(engine, settings):
    seed(engine, settings.timezone)
    add_legacy_machine(engine)
    with engine.begin() as conn:
        row_id = conn.execute(select(tables.compartments.c.id).where(tables.compartments.c.code == "row-a")).scalar()
        conn.execute(tables.readings.insert().values(compartment_id=row_id, t=utcnow(), received_at=utcnow(),
                                                     value=4.0, status="ok", calibration_version=1))
    deleted = remove_machine(engine, "snack-01")
    assert deleted["machines"] == 1 and deleted["compartments"] == 2 and deleted["readings"] == 1
    with engine.connect() as conn:
        assert [r[0] for r in conn.execute(select(tables.machines.c.id))] == ["coffee-01"]
        assert conn.execute(select(func.count()).select_from(tables.compartments)).scalar() == 3
    with pytest.raises(ValueError):
        remove_machine(engine, "coffee-01")          # a seeded machine is never removed
    with pytest.raises(LookupError):
        remove_machine(engine, "snack-01")           # already gone
