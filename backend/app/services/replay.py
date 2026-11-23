"""Replay mode: feed the coffee hoppers from the sales-derived ingredient use.

Starting a run loads the 24 source hours before `source_start` as history (one
reading per hopper every 5 source minutes), so the model can run at once. Each
tick then advances the source clock by `tick_s * speed` seconds and writes one
reading per hopper:

    stock = initial stock at source_start - grams used since source_start + noise

Readings and predictions carry the run id and the source time as their feature
clock, so live and replayed history never mix, and the dashboard can label them.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from sqlalchemy import Connection, select

from app import tables
from app.config import BACKEND_DIR
from app.ml.model import LoadedModel
from app.services.refills import Conflict, NotFound
from app.services.urgency import evaluate_and_log

DATA_PATH = BACKEND_DIR / "replay" / "sales_hopper_use.csv"
HOPPERS = ("coffee", "milk", "chocolate")
SEED_STEP = timedelta(minutes=5)
SEED_SPAN = timedelta(hours=24)


class InvalidReplay(ValueError):
    pass


@dataclass(frozen=True)
class SalesUse:
    times: np.ndarray                 # datetime64[ns], machine-local wall time, sorted
    cumulative: dict[str, np.ndarray]  # grams used up to and including each sale

    @property
    def first(self) -> datetime:
        return pd.Timestamp(self.times[0]).to_pydatetime()

    @property
    def last(self) -> datetime:
        return pd.Timestamp(self.times[-1]).to_pydatetime()

    def used(self, hopper: str, after: datetime, until: datetime) -> float:
        """Grams taken by sales with after < time <= until (naive local times)."""
        cum = np.concatenate([[0.0], self.cumulative[hopper]])
        lo = np.searchsorted(self.times, np.datetime64(after), side="right")
        hi = np.searchsorted(self.times, np.datetime64(until), side="right")
        return float(cum[hi] - cum[lo])


@lru_cache(maxsize=1)
def load_sales_use(path: Path = DATA_PATH) -> SalesUse:
    frame = pd.read_csv(path, parse_dates=["datetime"]).sort_values("datetime")
    return SalesUse(times=frame["datetime"].to_numpy(dtype="datetime64[ns]"),
                    cumulative={h: frame[f"{h}_g"].astype(float).cumsum().to_numpy() for h in HOPPERS})


def local_naive(t: datetime, tz: ZoneInfo) -> datetime:
    return t.astimezone(tz).replace(tzinfo=None)


def noisy(rng: np.random.Generator, value: float, sd: float) -> float:
    return value + (float(rng.normal(0.0, sd)) if sd > 0 else 0.0)


def status_for(value: float, capacity: float) -> tuple[str, float]:
    if value <= 0:
        return "ok", 0.0            # the hopper ran empty in the source data
    return ("over_capacity" if value > capacity else "ok"), value


def hoppers_of(conn: Connection, machine_id: str) -> dict[str, dict]:
    rows = conn.execute(select(tables.compartments).where(tables.compartments.c.machine_id == machine_id)).mappings()
    return {r["hopper_type"]: dict(r) for r in rows if r["hopper_type"] in HOPPERS}


def write_point(conn: Connection, run: dict, hoppers: dict, source_t: datetime, tz: ZoneInfo, now: datetime,
                data: SalesUse) -> None:
    """One reading per hopper at source time source_t (naive local)."""
    start_local = local_naive(run["source_start"], tz)
    rng = np.random.default_rng([run["seed"], int(source_t.replace(tzinfo=UTC).timestamp())])
    for hopper, comp in hoppers.items():
        initial = float(run["initial_stock"][hopper])
        if source_t <= start_local:
            true_stock = initial + data.used(hopper, source_t, start_local)
        else:
            true_stock = initial - data.used(hopper, start_local, source_t)
        status, value = status_for(noisy(rng, true_stock, run["noise_sd_g"]), comp["capacity"])
        conn.execute(tables.readings.insert().values(
            compartment_id=comp["id"], replay_run_id=run["id"], t=source_t.replace(tzinfo=tz), received_at=now,
            value=value, status=status, calibration_version=None))


def evaluate_run(conn: Connection, run: dict, hoppers: dict, tz: ZoneInfo, model: LoadedModel | None,
                 now: datetime, interval_s: float) -> None:
    for comp in hoppers.values():
        evaluate_and_log(conn, comp, tz, model, made_at=now, interval_s=interval_s, run_id=run["id"])


def start_replay(conn: Connection, machine_id: str, source_start: datetime, initial_stock: dict[str, float],
                 speed: float, noise_sd_g: float, model: LoadedModel | None, now: datetime,
                 interval_s: float, data: SalesUse | None = None) -> dict:
    data = data or load_sales_use()
    machine = conn.execute(select(tables.machines).where(tables.machines.c.id == machine_id)).mappings().first()
    if machine is None:
        raise NotFound("unknown machine")
    if machine["kind"] != "coffee":
        raise InvalidReplay("replay is available for the coffee machine only")
    if machine["mode"] == "replay":
        raise Conflict("a replay is already running; stop it first")
    tz = ZoneInfo(machine["timezone"])
    start = source_start.astimezone(tz).replace(tzinfo=None) if source_start.tzinfo else source_start
    if not (data.first + SEED_SPAN <= start <= data.last):
        raise InvalidReplay(f"source_start must be between {data.first + SEED_SPAN:%Y-%m-%d %H:%M} "
                            f"and {data.last:%Y-%m-%d %H:%M} (24 hours of sales are needed before it)")
    hoppers = hoppers_of(conn, machine_id)
    if set(initial_stock) != set(HOPPERS):
        raise InvalidReplay("initial_stock_g needs exactly coffee, milk, and chocolate")
    for hopper, grams in initial_stock.items():
        if not 0 < grams <= hoppers[hopper]["capacity"]:
            raise InvalidReplay(f"initial stock for {hopper} must be above 0 and at most the capacity")

    start_aware = start.replace(tzinfo=tz)
    run_id = conn.execute(tables.replay_runs.insert().values(
        machine_id=machine_id, status="running", source_start=start_aware, source_clock=start_aware,
        speed=speed, initial_stock={h: float(g) for h, g in initial_stock.items()}, noise_sd_g=noise_sd_g,
        seed=int(np.random.default_rng().integers(1, 2**31 - 1)), started_at=now)).inserted_primary_key[0]
    run = dict(conn.execute(select(tables.replay_runs).where(tables.replay_runs.c.id == run_id)).mappings().one())

    tau = start - SEED_SPAN
    while tau <= start:
        write_point(conn, run, hoppers, tau, tz, now, data)
        tau += SEED_STEP
    conn.execute(tables.machines.update().where(tables.machines.c.id == machine_id).values(mode="replay"))
    evaluate_run(conn, run, hoppers, tz, model, now, interval_s)
    return {"run_id": run_id, "status": "running", "source_start": start_aware.isoformat(), "speed": speed}


def tick(conn: Connection, run: dict, step_s: float, model: LoadedModel | None, now: datetime,
         interval_s: float, data: SalesUse | None = None) -> dict:
    """Advance one running replay by step_s real seconds."""
    data = data or load_sales_use()
    machine = conn.execute(select(tables.machines).where(tables.machines.c.id == run["machine_id"])).mappings().one()
    tz = ZoneInfo(machine["timezone"])
    clock = local_naive(run["source_clock"], tz) + timedelta(seconds=step_s * run["speed"])
    if clock > data.last:
        finish(conn, run["id"], run["machine_id"], "finished", now)
        return {"run_id": run["id"], "status": "finished"}
    hoppers = hoppers_of(conn, run["machine_id"])
    write_point(conn, run, hoppers, clock, tz, now, data)
    conn.execute(tables.replay_runs.update().where(tables.replay_runs.c.id == run["id"])
                 .values(source_clock=clock.replace(tzinfo=tz)))
    evaluate_run(conn, run, hoppers, tz, model, now, interval_s)
    return {"run_id": run["id"], "status": "running", "source_time": clock.replace(tzinfo=tz).isoformat()}


def finish(conn: Connection, run_id: int, machine_id: str, status: str, now: datetime) -> None:
    conn.execute(tables.replay_runs.update().where(tables.replay_runs.c.id == run_id)
                 .values(status=status, ended_at=now))
    conn.execute(tables.machines.update().where(tables.machines.c.id == machine_id).values(mode="live"))


def stop_replay(conn: Connection, machine_id: str, now: datetime) -> dict:
    rr = tables.replay_runs
    run = conn.execute(select(rr).where(rr.c.machine_id == machine_id, rr.c.status == "running")
                       .order_by(rr.c.id.desc()).limit(1)).mappings().first()
    if run is None:
        raise Conflict("no replay is running")
    finish(conn, run["id"], machine_id, "stopped", now)
    return {"run_id": run["id"], "status": "stopped"}


def running_runs(conn: Connection) -> list[dict]:
    rr = tables.replay_runs
    return [dict(r) for r in conn.execute(select(rr).where(rr.c.status == "running")).mappings()]
