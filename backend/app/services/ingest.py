"""Store one kit batch: authenticate, re-check every reading, reject duplicates."""

import hashlib
import hmac
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import Connection, select
from sqlalchemy.exc import IntegrityError

from app import tables
from app.schemas import BatchIn

HOPPER_REJECT_BELOW_G = -10.0     # firmware rule: below -10 g is rejected
HOPPER_REJECT_ABOVE_G = 1050.0    # firmware rule: above 1,050 g is rejected


class UnknownMachine(Exception):
    pass


class BadDeviceKey(Exception):
    pass


class DuplicateBatch(Exception):
    pass


class UnknownCompartment(Exception):
    pass


@dataclass
class StoredBatch:
    batch_id: int
    machine: dict
    reading_ids: list[int]
    compartment_ids: list[int]


def authenticate(conn: Connection, machine_id: str, device_key: str | None) -> dict:
    machine = conn.execute(select(tables.machines).where(tables.machines.c.id == machine_id)).mappings().first()
    if machine is None:
        raise UnknownMachine(machine_id)
    supplied = hashlib.sha256((device_key or "").encode("utf-8")).hexdigest()
    if not device_key or not hmac.compare_digest(supplied, machine["device_key_hash"]):
        raise BadDeviceKey(machine_id)
    return dict(machine)


def recheck(compartment: dict, status: str, value: float | None) -> tuple[str, float | None]:
    """Apply the firmware's range rules again, so a faulty kit cannot store an impossible value."""
    if value is None:
        return status, None
    capacity = compartment["capacity"]
    if compartment["unit"] == "g":
        if value < HOPPER_REJECT_BELOW_G or value > HOPPER_REJECT_ABOVE_G:
            return "out_of_range", None
        if value < 0:
            return "corrected_zero", 0.0
        if value > capacity:
            return "over_capacity", value
        return ("corrected_zero" if status == "corrected_zero" and value == 0 else "ok"), value
    # coil row: whole items between 0 and capacity
    if value < 0:
        return "out_of_range", None
    value = float(round(value))
    if value > capacity:
        return "over_capacity", value
    return "ok", value


def store_batch(conn: Connection, batch: BatchIn, device_key: str | None, received_at: datetime) -> StoredBatch:
    machine = authenticate(conn, batch.machine_id, device_key)
    comps = {row["code"]: dict(row) for row in conn.execute(
        select(tables.compartments).where(tables.compartments.c.machine_id == machine["id"])).mappings()}
    unknown = [r.compartment for r in batch.readings if r.compartment not in comps]
    if unknown:
        raise UnknownCompartment(", ".join(unknown))

    seen = conn.execute(select(tables.batches.c.id).where(
        tables.batches.c.machine_id == machine["id"], tables.batches.c.session_id == batch.session_id,
        tables.batches.c.sequence == batch.sequence)).first()
    if seen is not None:
        raise DuplicateBatch()
    try:
        with conn.begin_nested():
            batch_id = conn.execute(tables.batches.insert().values(
                machine_id=machine["id"], session_id=batch.session_id, sequence=batch.sequence,
                device_time=batch.device_time, received_at=received_at)).inserted_primary_key[0]
    except IntegrityError as exc:  # two copies arriving at the same moment
        raise DuplicateBatch() from exc

    reading_ids, compartment_ids = [], []
    for reading in batch.readings:
        comp = comps[reading.compartment]
        status, value = recheck(comp, reading.status, reading.value)
        rid = conn.execute(tables.readings.insert().values(
            compartment_id=comp["id"], batch_id=batch_id, replay_run_id=None, t=received_at,
            received_at=received_at, value=value, status=status,
            calibration_version=reading.calibration_version)).inserted_primary_key[0]
        reading_ids.append(rid)
        compartment_ids.append(comp["id"])
    return StoredBatch(batch_id=batch_id, machine=machine, reading_ids=reading_ids,
                       compartment_ids=compartment_ids)
