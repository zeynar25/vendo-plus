"""Shared test fixtures.

Tests use a fresh SQLite file by default. To run the same tests on PostgreSQL:
    TEST_DATABASE_URL=postgresql://user@host:port/dbname python -m pytest
"""

import os

import pytest

from app import tables
from app.cli import seed
from app.config import Settings
from app.db import create_db_engine


@pytest.fixture
def settings(tmp_path) -> Settings:
    url = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{tmp_path / 'test.db'}"
    return Settings(database_url=url, enable_replay_runner=False, _env_file=None)


@pytest.fixture
def engine(settings):
    eng = create_db_engine(settings.database_url)
    tables.metadata.drop_all(eng)
    tables.metadata.create_all(eng)
    yield eng
    tables.metadata.drop_all(eng)
    eng.dispose()


@pytest.fixture
def device_keys(engine, settings) -> dict[str, str]:
    return seed(engine, settings.timezone)
