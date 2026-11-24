"""Command-line tasks. Run from the backend folder with DATABASE_URL set:

    python -m app.cli init-db                # create missing tables
    python -m app.cli seed                   # add the two machines; prints NEW device keys once
    python -m app.cli seed --rotate-keys     # issue new keys for both machines (old keys stop working)
"""

import argparse
import hashlib
import secrets

from sqlalchemy import Engine, select

from app import tables
from app.config import Settings
from app.db import create_db_engine, init_db, utcnow
from app.seed_data import MACHINES


def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def seed(engine: Engine, timezone: str, rotate_keys: bool = False) -> dict[str, str]:
    """Insert missing machines and compartments. Returns {machine_id: plain key} for keys issued now."""
    issued: dict[str, str] = {}
    with engine.begin() as conn:
        for machine in MACHINES:
            exists = conn.execute(select(tables.machines.c.id)
                                  .where(tables.machines.c.id == machine["id"])).first()
            if exists is None or rotate_keys:
                key = secrets.token_urlsafe(24)
                issued[machine["id"]] = key
            if exists is None:
                conn.execute(tables.machines.insert().values(
                    id=machine["id"], name=machine["name"], kind=machine["kind"], timezone=timezone,
                    device_key_hash=hash_key(issued[machine["id"]]), mode="live", created_at=utcnow()))
            elif rotate_keys:
                conn.execute(tables.machines.update().where(tables.machines.c.id == machine["id"])
                             .values(device_key_hash=hash_key(issued[machine["id"]])))
            for comp in machine["compartments"]:
                found = conn.execute(select(tables.compartments.c.id).where(
                    tables.compartments.c.machine_id == machine["id"],
                    tables.compartments.c.code == comp["code"])).first()
                if found is None:
                    conn.execute(tables.compartments.insert().values(machine_id=machine["id"], **comp))
    return issued


def remove_machine(engine: Engine, machine_id: str) -> dict[str, int]:
    """Delete a machine that is no longer seeded, with every row that belongs to it.

    Returns the number of rows deleted per table. A seeded machine is never removed.
    """
    if machine_id in {m["id"] for m in MACHINES}:
        raise ValueError(f"{machine_id} is a seeded machine and cannot be removed")
    t = tables
    deleted: dict[str, int] = {}
    with engine.begin() as conn:
        if conn.execute(select(t.machines.c.id).where(t.machines.c.id == machine_id)).first() is None:
            raise LookupError(f"{machine_id} is not in the database")
        comp_ids = select(t.compartments.c.id).where(t.compartments.c.machine_id == machine_id)
        for table in (t.predictions, t.acknowledgements, t.history_resets, t.readings, t.refills):
            deleted[table.name] = conn.execute(table.delete().where(table.c.compartment_id.in_(comp_ids))).rowcount
        for table in (t.replay_runs, t.batches, t.compartments):
            deleted[table.name] = conn.execute(table.delete().where(table.c.machine_id == machine_id)).rowcount
        deleted[t.machines.name] = conn.execute(t.machines.delete().where(t.machines.c.id == machine_id)).rowcount
    return deleted


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init-db", help="create missing tables")
    seed_cmd = sub.add_parser("seed", help="add the prototype machines and issue device keys")
    seed_cmd.add_argument("--rotate-keys", action="store_true")
    remove_cmd = sub.add_parser("remove-machine", help="delete a machine that is no longer seeded, with all its rows")
    remove_cmd.add_argument("machine_id")
    remove_cmd.add_argument("--yes", action="store_true", help="confirm the deletion; it cannot be undone")
    args = parser.parse_args(argv)

    settings = Settings()
    engine = create_db_engine(settings.database_url)
    init_db(engine)
    if args.command == "init-db":
        print("Tables are ready.")
    elif args.command == "seed":
        issued = seed(engine, settings.timezone, rotate_keys=args.rotate_keys)
        if not issued:
            print("Machines already exist; no new keys issued (use --rotate-keys to replace them).")
        for machine_id, key in issued.items():
            print(f"{machine_id} device key: {key}")
        if issued:
            print("Copy each key into that kit's firmware now; only its hash is stored.")
    elif args.command == "remove-machine":
        if not args.yes:
            raise SystemExit(f"This deletes {args.machine_id} and all its readings. Run again with --yes to confirm.")
        try:
            deleted = remove_machine(engine, args.machine_id)
        except (ValueError, LookupError) as error:
            raise SystemExit(str(error))
        for name, count in deleted.items():
            print(f"{name}: {count} row(s) deleted")


if __name__ == "__main__":
    main()
