"""Request and response bodies (see docs/api-contract.md)."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

Status = Literal["ok", "corrected_zero", "over_capacity", "unavailable", "out_of_range"]
VALUE_STATUSES = {"ok", "corrected_zero", "over_capacity"}


class ReadingIn(BaseModel):
    compartment: str = Field(min_length=1, max_length=32)
    value: float | None = None
    status: Status
    calibration_version: int = Field(ge=1)

    @model_validator(mode="after")
    def value_matches_status(self):
        if self.status in VALUE_STATUSES and self.value is None:
            raise ValueError(f"status '{self.status}' needs a value")
        if self.status not in VALUE_STATUSES:
            self.value = None  # an invalid reading is never stored as a number
        return self


class BatchIn(BaseModel):
    machine_id: str = Field(min_length=1, max_length=32)
    session_id: str = Field(min_length=1, max_length=64)
    sequence: int = Field(ge=0)
    device_time: datetime | None = None
    readings: list[ReadingIn] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def compartments_unique(self):
        codes = [r.compartment for r in self.readings]
        if len(codes) != len(set(codes)):
            raise ValueError("each compartment may appear at most once per batch")
        return self


class BatchAccepted(BaseModel):
    batch_id: int
    accepted: int
    machine_mode: str


class ReplayStart(BaseModel):
    # Source (dataset) time to start at, in the machine's local time, e.g. "2025-01-15T07:00:00".
    source_start: datetime
    initial_stock_g: dict[str, float]
    # Source seconds per real second. At most 180, so readings stay within 15 source minutes of each other.
    speed: float = Field(default=60.0, ge=1.0, le=180.0)
    noise_sd_g: float = Field(default=2.0, ge=0.0, le=20.0)
