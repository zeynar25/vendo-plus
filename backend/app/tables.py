"""Database tables (SQLAlchemy Core). The same definitions work on SQLite and PostgreSQL.

The whole schema is defined here at once, because create_all() only adds
missing tables and never changes existing ones.
"""

from datetime import UTC, datetime

from sqlalchemy import (JSON, BigInteger, Column, DateTime, Float, ForeignKey, Index, Integer,
                        MetaData, String, Table, TypeDecorator, UniqueConstraint)

metadata = MetaData()

# BIGINT keys on PostgreSQL; SQLite needs INTEGER for auto-increment.
BigId = BigInteger().with_variant(Integer(), "sqlite")


class UTCDateTime(TypeDecorator):
    """Store every time as UTC and always read it back as an aware UTC datetime.

    PostgreSQL keeps the offset; SQLite silently drops it, so converting before
    writing is what makes both databases agree.
    """
    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC)

    def process_result_value(self, value: datetime | None, dialect):
        if value is None:
            return None
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


TS = UTCDateTime()

machines = Table(
    "machines", metadata,
    Column("id", String(32), primary_key=True),             # e.g. coffee-01
    Column("name", String(80), nullable=False),
    Column("kind", String(16), nullable=False),              # coffee | snack
    Column("timezone", String(64), nullable=False),
    Column("device_key_hash", String(64), nullable=False),   # SHA-256 of the device key
    Column("mode", String(16), nullable=False, default="live"),  # live | replay
    Column("created_at", TS, nullable=False),
)

compartments = Table(
    "compartments", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("machine_id", String(32), ForeignKey("machines.id"), nullable=False),
    Column("code", String(32), nullable=False),              # coffee | milk | chocolate | row-a ...
    Column("name", String(80), nullable=False),
    Column("sensor", String(16), nullable=False),            # load_cell | ultrasonic
    Column("unit", String(8), nullable=False),               # g | items
    Column("capacity", Float, nullable=False),
    Column("hopper_type", String(16)),                       # coffee | milk | chocolate (hoppers only)
    Column("position", Integer, nullable=False),
    UniqueConstraint("machine_id", "code", name="uq_compartment_code"),
)

replay_runs = Table(
    "replay_runs", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("machine_id", String(32), ForeignKey("machines.id"), nullable=False),
    Column("status", String(16), nullable=False),            # running | stopped | finished
    Column("source_start", TS, nullable=False),              # source (dataset) time replay starts at
    Column("source_clock", TS, nullable=False),              # source time of the latest replayed reading
    Column("speed", Float, nullable=False),                  # source seconds per real second
    Column("initial_stock", JSON, nullable=False),           # {"coffee": 150, ...} grams at source_start
    Column("noise_sd_g", Float, nullable=False),
    Column("seed", Integer, nullable=False),
    Column("started_at", TS, nullable=False),
    Column("ended_at", TS),
)

batches = Table(
    "batches", metadata,
    Column("id", BigId, primary_key=True, autoincrement=True),
    Column("machine_id", String(32), ForeignKey("machines.id"), nullable=False),
    Column("session_id", String(64), nullable=False),
    Column("sequence", BigInteger, nullable=False),
    Column("device_time", TS),
    Column("received_at", TS, nullable=False),
    UniqueConstraint("machine_id", "session_id", "sequence", name="uq_batch_sequence"),
)

readings = Table(
    "readings", metadata,
    Column("id", BigId, primary_key=True, autoincrement=True),
    Column("compartment_id", Integer, ForeignKey("compartments.id"), nullable=False),
    Column("batch_id", BigId, ForeignKey("batches.id")),           # null for replayed readings
    Column("replay_run_id", Integer, ForeignKey("replay_runs.id")),  # null = live reading
    Column("t", TS, nullable=False),            # feature clock: receive time (live) or source time (replay)
    Column("received_at", TS, nullable=False),  # real time the backend stored it
    Column("value", Float),                     # grams or items; null when unavailable/out of range
    Column("status", String(16), nullable=False),
    Column("calibration_version", Integer),
    Index("ix_readings_compartment_t", "compartment_id", "t"),
)

refills = Table(
    "refills", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("compartment_id", Integer, ForeignKey("compartments.id"), nullable=False),
    Column("status", String(16), nullable=False),       # open | closed | cancelled
    Column("kind", String(16), nullable=False),         # recorded | reconciled
    Column("started_at", TS, nullable=False),
    Column("ended_at", TS),
    Column("before_value", Float),
    Column("after_value", Float),
    Column("added", Float),
)

history_resets = Table(
    "history_resets", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("compartment_id", Integer, ForeignKey("compartments.id"), nullable=False),
    Column("replay_run_id", Integer, ForeignKey("replay_runs.id")),
    Column("at", TS, nullable=False),                    # feature-clock time of the jump or change
    Column("reason", String(32), nullable=False),        # unrecorded_refill | calibration_change
    Column("jump", Float),                               # size of an unrecorded refill
    Column("reconciled_at", TS),
    Column("refill_id", Integer, ForeignKey("refills.id")),
)

predictions = Table(
    "predictions", metadata,
    Column("id", BigId, primary_key=True, autoincrement=True),
    Column("compartment_id", Integer, ForeignKey("compartments.id"), nullable=False),
    Column("replay_run_id", Integer, ForeignKey("replay_runs.id")),
    Column("t", TS, nullable=False),                     # feature clock of the reading predicted from
    Column("made_at", TS, nullable=False),
    Column("label", String(8), nullable=False),          # Low | Medium | High
    Column("method", String(8), nullable=False),         # model | basic
    Column("reason", String(32)),                        # why basic was used; null for model
    Column("model_version", String(64)),                 # SHA-256 of the model file
    Column("features", JSON),                            # the 11 model inputs, in training order
    Index("ix_predictions_compartment_made", "compartment_id", "made_at"),
)

acknowledgements = Table(
    "acknowledgements", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("compartment_id", Integer, ForeignKey("compartments.id"), nullable=False),
    Column("replay_run_id", Integer, ForeignKey("replay_runs.id")),
    Column("label", String(8), nullable=False),
    Column("acknowledged_at", TS, nullable=False),
)

service_events = Table(
    "service_events", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("kind", String(32), nullable=False),          # startup | first_request
    Column("at", TS, nullable=False),
    Column("detail", JSON),
)
