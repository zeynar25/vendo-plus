# Vendo+ API contract (v1)

This is the agreement between the Wokwi kits, the backend, and the dashboard.
The firmware and the frontend follow this file; if the code and this file
disagree, fix one of them in the same commit.

- Base URL: `https://<service-name>.onrender.com` (local: `http://127.0.0.1:8000`)
- All bodies are JSON. All times are ISO 8601 with an offset (UTC `Z` recommended).
- Interactive docs generated from the code: `GET /docs`.

## Machines and compartments

The seed command (`python -m app.cli seed`) creates these two machines and prints
one device key per machine. Keys are stored only as SHA-256 hashes.

| machine_id | Kind | Compartment codes | Sensor | Unit | Capacity |
| --- | --- | --- | --- | --- | --- |
| `coffee-01` | coffee | `coffee`, `milk`, `chocolate` | load cell + HX711 | g | 1,000 |
| `snack-01` | snack and drink | `row-a`, `row-b`, `row-c` | HC-SR04 | items | 10 |

## 1. Kit to backend: `POST /api/v1/readings`

One batch per machine every 5 seconds, holding all of that machine's compartments.

Headers:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `X-Device-Key` | the machine's key printed by the seed command |

Body:

```json
{
  "machine_id": "coffee-01",
  "session_id": "1001efa656df",
  "sequence": 128,
  "device_time": "2026-11-19T14:05:00Z",
  "readings": [
    {"compartment": "coffee",    "value": 512.4, "status": "ok",             "calibration_version": 1},
    {"compartment": "milk",      "value": 0.0,   "status": "corrected_zero", "calibration_version": 1},
    {"compartment": "chocolate", "value": null,  "status": "unavailable",    "calibration_version": 1}
  ]
}
```

| Field | Rule |
| --- | --- |
| `machine_id` | Must match the machine the key belongs to. |
| `session_id` | 1 to 64 characters. A new value at every boot of the kit. |
| `sequence` | Integer of 0 or more, increasing by 1 per batch within a session. |
| `device_time` | Optional. Stored for audit only; the server's receive time is the reading time. |
| `readings` | 1 to 3 items, each compartment at most once. |
| `value` | Grams for a hopper, items left for a coil row. `null` when `status` is `unavailable` or `out_of_range`. |
| `calibration_version` | Integer of 1 or more. A change starts a new 24-hour history for that compartment. |

Status values (decided by the firmware, re-checked by the backend):

| `status` | Meaning | Used for urgency? |
| --- | --- | --- |
| `ok` | Valid converted reading | Yes |
| `corrected_zero` | Hopper read from -10 g to 0 g, sent as 0 | Yes |
| `over_capacity` | Above capacity (hopper over 1,050 g, coil row over 10 items) | No, stored only |
| `unavailable` | Channel not ready, or no echo before the timeout | No |
| `out_of_range` | Rejected reading (hopper below -10 g, distance outside the calibrated range) | No |

The firmware never sends an invalid reading as a valid zero. If a delivery fails,
the next batch carries the newest state; old values are never replayed as current.

Responses:

| Code | When | Body |
| --- | --- | --- |
| 201 | Batch stored | `{"batch_id": 41, "accepted": 3, "machine_mode": "live"}` |
| 401 | Missing key, or key does not belong to `machine_id` | `{"detail": "..."}` |
| 404 | Unknown `machine_id` | `{"detail": "..."}` |
| 409 | The same `(machine_id, session_id, sequence)` was already stored | `{"detail": "duplicate batch"}` |
| 422 | Invalid body, unknown compartment, or a compartment repeated | FastAPI validation error |

## 2. Dashboard to backend

Read endpoints are open. Operator actions (every `POST` below) require the header
`X-Operator-Key` when the server's `OPERATOR_KEY` setting is not empty.

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/status` | Overview, polled every 2 s: machines and compartments ranked by urgency |
| `GET /api/v1/compartments/{id}` | Detail: last 24 h of readings, consumption rate, calibration version, recent alerts |
| `GET /api/v1/compartments/{id}/refills` | Refill history |
| `POST /api/v1/compartments/{id}/refill/start` | Enter refill mode (records the stable reading before) |
| `POST /api/v1/compartments/{id}/refill/end` | Leave refill mode (records the stable reading after and the amount added) |
| `POST /api/v1/compartments/{id}/refill/cancel` | Leave refill mode without recording a refill |
| `POST /api/v1/compartments/{id}/acknowledge` | Hide the current Medium or High alert until the urgency changes |
| `POST /api/v1/history-resets/{id}/reconcile` | Record a detected, unrecorded refill so the history counts again |
| `POST /api/v1/machines/{machine_id}/replay/start` | Start labeled replay mode on the coffee machine |
| `POST /api/v1/machines/{machine_id}/replay/stop` | Stop replay and return to live readings |
| `GET /api/v1/system/check` | Pre-demo check: database, model, and the latest value on every channel |

### Urgency shown for each compartment

| Field | Values |
| --- | --- |
| `label` | `Low`, `Medium`, `High`, or `null` while no valid reading exists or a refill is open |
| `method` | `model` (Random Forest) or `basic` (basic stock warning) |
| `reason` | Why the basic warning is used: `coil_row`, `history_short`, `history_gap`, `history_reset`, `refill_in_window`, `model_unavailable`; `null` for `model` |

Basic stock warning (the stock-only baseline): High at or below 5% of capacity,
Medium at or below 20%, Low above that. For a 1,000 g hopper that is 50 g and
200 g; for a 10-item coil row it is 0 items and 2 items.

The model is used only when all of these hold. Otherwise the basic warning is shown:

1. The compartment is a hopper. Coil rows always get the basic warning, because the model was trained and evaluated on hoppers only.
2. The current reading is `ok` or `corrected_zero`, and no refill is open.
3. The compartment has 24 hours of history in the current run (live, or one replay run), with no unreconciled reset in that time.
4. For each window (1 h, 6 h, 24 h) there is a valid reading at or before the window start, at most 15 minutes before it, and the window start is not inside a refill.

Features are computed exactly as in training (`ml/features.py`): stock ratio,
consumption over the last 1, 6, and 24 hours as a share of capacity per hour,
hour and weekday as sine and cosine in the machine's local time, and the hopper type.
Live consumption over a window = stock at the window start - stock now + grams
added by refills that ended inside the window, floored at 0.

### Freshness rules

- `reading_age_s` is highlighted (`stale: true`) after 10 s, meaning two batches were missed.
- A machine is `online: false` after 15 s without a valid reading; the dashboard then shows an offline message instead of the stock values.
- Ranking inside a machine: High, then Medium, then Low; ties by lower stock percentage.

### Refill mode

- Stable means three consecutive valid reports within 5 g (hopper) or with the same count (coil row).
- `refill/start` needs a stable reading before; `refill/end` needs a stable reading after the start. If not yet stable, the call returns 409 with `{"detail": "not stable"}` and the dashboard retries after a few seconds.
- Amount added = after - before, floored at 0.
- A rise of more than 20 g (hopper) or of 1 item or more (coil row) outside refill mode is recorded as an unrecorded refill. It starts a new 24-hour history until an operator reconciles it.
- Acknowledging an alert only hides it; it never changes the recorded stock.

### Replay mode (coffee machine only)

Replay feeds the coffee hoppers from the sales-derived ingredient use (recipe R2)
instead of the Wokwi load cells, so the model can be shown without waiting 24 hours.

```json
POST /api/v1/machines/coffee-01/replay/start
{"source_start": "2025-01-15T07:00:00", "initial_stock_g": {"coffee": 150, "milk": 150, "chocolate": 100}, "speed": 60}
```

- The backend first loads the 24 source hours before `source_start` as history, then advances the source clock by `speed` seconds per real second (60 = one source hour per real minute) and writes one simulated reading per hopper every 5 real seconds, with 2 g Gaussian noise.
- Every reading and prediction from replay carries the run id, and `/status` shows `mode: "replay"` with the source time, so a 2025 source timestamp is never shown as a current reading.
- Live kit batches are still stored during replay but do not drive urgency until replay stops.
