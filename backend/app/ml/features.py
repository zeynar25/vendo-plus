"""Live features: the same 11 inputs as ml/features.py, computed from stored readings.

Training computed consumption from exact sale times. Live, it is estimated from the
change in measured stock, adjusted for recorded refills:

    used in (t - w, t] = stock at the window start - stock now + grams added by
                         refills that ended inside the window, floored at 0
    rate_w             = used / capacity / w        (share of capacity per hour)

The model may run only when every window has a valid reading at or before its start
(at most 15 minutes before it) inside the current history, and no window starts in
the middle of a refill. Otherwise the caller shows the basic stock warning.
"""

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

FEATURE_COLUMNS = [
    "stock_ratio", "rate_1h", "rate_6h", "rate_24h",
    "hour_sin", "hour_cos", "weekday_sin", "weekday_cos",
    "hopper_coffee", "hopper_milk", "hopper_chocolate",
]
HOPPER_TYPES = ("coffee", "milk", "chocolate")
WINDOWS_H = (1, 6, 24)
MAX_BOUNDARY_GAP = timedelta(minutes=15)
VALID_STATUSES = {"ok", "corrected_zero"}


@dataclass(frozen=True)
class Reading:
    t: datetime
    value: float | None
    status: str


@dataclass(frozen=True)
class RefillSpan:
    started_at: datetime
    ended_at: datetime | None   # None = still open
    added: float                # grams or items added (0 while open)


@dataclass(frozen=True)
class FeatureResult:
    features: dict[str, float] | None
    reason: str | None          # why the model may not run; None when features are ready


def time_features(t: datetime, tz: ZoneInfo) -> dict[str, float]:
    local = t.astimezone(tz)
    hour, weekday = local.hour, local.weekday()   # Monday = 0, as in training
    return {
        "hour_sin": math.sin(2 * math.pi * hour / 24), "hour_cos": math.cos(2 * math.pi * hour / 24),
        "weekday_sin": math.sin(2 * math.pi * weekday / 7), "weekday_cos": math.cos(2 * math.pi * weekday / 7),
    }


def compute_features(readings: list[Reading], refills: list[RefillSpan], *, capacity: float,
                     hopper_type: str, tz: ZoneInfo, history_start: datetime | None,
                     reset_active: bool = False) -> FeatureResult:
    """readings: this compartment's readings in the current run, oldest first, ending with the current one.

    history_start: the earliest time the history may be used from (the latest unreconciled
    reset or calibration change), or None. reset_active tells whether that start comes from
    a reset, which only changes the reason reported.
    """
    current = readings[-1]
    if current.status not in VALID_STATUSES or current.value is None:
        raise ValueError("compute_features needs a valid current reading")
    t = current.t
    valid = [r for r in readings if r.status in VALID_STATUSES and r.value is not None
             and (history_start is None or r.t >= history_start)]

    rates = {}
    for hours in WINDOWS_H:
        start = t - timedelta(hours=hours)
        before = [r for r in valid if r.t <= start]
        if not before:
            return FeatureResult(None, "history_reset" if reset_active else "history_short")
        anchor = before[-1]
        if start - anchor.t > MAX_BOUNDARY_GAP:
            return FeatureResult(None, "history_gap")
        for refill in refills:
            if refill.started_at <= start and (refill.ended_at is None or refill.ended_at > start):
                return FeatureResult(None, "refill_in_window")
        added = sum(f.added for f in refills if f.ended_at is not None and start < f.ended_at <= t)
        used = max(0.0, anchor.value - current.value + added)
        rates[f"rate_{hours}h"] = used / capacity / hours

    features = {"stock_ratio": current.value / capacity, **rates, **time_features(t, tz)}
    for kind in HOPPER_TYPES:
        features[f"hopper_{kind}"] = 1.0 if hopper_type == kind else 0.0
    return FeatureResult({c: features[c] for c in FEATURE_COLUMNS}, None)
