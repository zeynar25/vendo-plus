# Vendo+ backend

FastAPI service that receives the kits' readings, predicts restock urgency with
the selected Random Forest, and serves the operator dashboard. It runs on Render
with a Supabase PostgreSQL database.

- API contract (what the firmware and the dashboard must send and expect): `../docs/api-contract.md`
- Deployment, step by step: `../docs/backend-deploy.md`
- Interactive API docs once running: `/docs`

## Layout

| Path | What it holds |
| --- | --- |
| `app/main.py` | App factory, startup (database, model, replay loop), timing and cold-start log |
| `app/config.py` | Settings from environment variables |
| `app/tables.py`, `app/db.py` | Database schema and engine (SQLite locally, PostgreSQL on Supabase) |
| `app/cli.py`, `app/seed_data.py` | `init-db` and `seed` commands; the two prototype machines |
| `app/ml/model.py` | Loads the model only if its hash, scikit-learn version, and features match `model/selection.json` |
| `app/ml/features.py` | The 11 live features, identical to `ml/features.py` |
| `app/services/` | Ingest, urgency, dashboard, refills, replay |
| `app/routes/` | HTTP endpoints |
| `model/` | The deployed model and its selection record |
| `replay/` | Sales-derived hopper use for replay mode |
| `tests/` | 84 tests; set `TEST_DATABASE_URL` to also run them on PostgreSQL |

## Environment variables

| Name | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:///./vendoplus-dev.db` | Supabase Session pooler string in production |
| `OPERATOR_KEY` | empty | When set, every dashboard POST needs header `X-Operator-Key` |
| `TIMEZONE` | `Asia/Manila` | Machines' local time for the hour and weekday features |
| `CORS_ORIGINS` | `*` | Browser origins allowed to call the API (comma-separated) |
| `AUTO_CREATE_TABLES` | `true` | Create missing tables at startup |
| `REPLAY_TICK_S` | `5` | Real seconds between replayed readings |
| `ENABLE_REPLAY_RUNNER` | `true` | Run the replay loop inside the web process |

## Run locally

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
python -m pip install -r requirements-dev.txt
python -m pytest
python -m app.cli seed            # prints a device key per machine (local SQLite)
uvicorn app.main:app --reload
```

Then open http://127.0.0.1:8000/docs.
