# Deploying the backend (Supabase + Render free plan)

The backend is one Render web service (`render.yaml`) using a Supabase PostgreSQL
database. Render's free plan keeps no files between restarts, so the local SQLite
default must never be used there.

## 1. Create the database (Supabase)

1. Create a Supabase project and note its database password.
2. Click **Connect** and copy the **Session pooler** connection string
   (`postgresql://postgres.<ref>:<password>@aws-<n>-<region>.pooler.supabase.com:5432/postgres`).
   Do not use the "Direct connection": it is IPv6, and Render cannot reach it.

## 2. Create the tables and the device keys (once, from your laptop)

```bash
cd backend
python -m pip install -r requirements-dev.txt
# Windows PowerShell: $env:DATABASE_URL="<session pooler string>"
export DATABASE_URL="<session pooler string>"
python -m app.cli seed
```

The command creates every table and the coffee machine, and prints its device key.
Copy the key into the kit's firmware secrets now; the database keeps only a hash.
Running `seed` again prints nothing new; `seed --rotate-keys` issues a new key.

If this database was seeded by an earlier version, it may still hold the snack and
drink machine, which is no longer part of the project. Remove it and all its rows with
`python -m app.cli remove-machine snack-01 --yes` (this cannot be undone).

## 3. Deploy on Render

1. Push this repository to GitHub.
2. In Render: **New > Blueprint**, pick the repository, and apply `render.yaml`.
3. When asked, paste the Session pooler string into `DATABASE_URL`. Set `OPERATOR_KEY`
   to a long random string if dashboard actions should need a key, or leave it empty.
4. Wait for the build (it installs scikit-learn 1.9.1, the version the model was trained with).

Python 3.13 comes from `.python-version` at the repository root.

## 4. Check it

| Check | Expected |
| --- | --- |
| `GET https://<service>.onrender.com/healthz` | `{"status": "ok", ...}` |
| `GET /api/v1/system/check` | `"ready": true`, `model.algorithm` = `random_forest`, `model.sha256` starts with `768aaa18` |
| `GET /api/v1/status` | The coffee machine, offline until the kit sends readings |

Send one batch by hand (replace the key):

```bash
curl -X POST https://<service>.onrender.com/api/v1/readings \
  -H "Content-Type: application/json" -H "X-Device-Key: <coffee-01 key>" \
  -d '{"machine_id":"coffee-01","session_id":"manual-1","sequence":1,
       "readings":[{"compartment":"coffee","value":512.4,"status":"ok","calibration_version":1}]}'
```

Expect `201`. Sending the same body again returns `409` (duplicate batch).

## 5. Replay demo (coffee machine)

```bash
curl -X POST https://<service>.onrender.com/api/v1/machines/coffee-01/replay/start \
  -H "Content-Type: application/json" \
  -d '{"source_start":"2025-01-15T07:00:00","initial_stock_g":{"coffee":150,"milk":150,"chocolate":100},"speed":60}'
# ... watch /api/v1/status: mode "replay", source time moving 5 minutes every 5 s
curl -X POST https://<service>.onrender.com/api/v1/machines/coffee-01/replay/stop
```

Add `-H "X-Operator-Key: <key>"` to both calls when `OPERATOR_KEY` is set.

## Free-plan behaviour to expect

- Render spins a free web service down after 15 minutes without inbound requests, and
  the next request waits about a minute while it starts. While kits post every 5 s or the
  dashboard polls every 2 s, the service stays up because that is real traffic.
- Each start writes a `startup` event, and the first non-health request after it writes
  a `first_request` event with its timing. `GET /api/v1/system/check` lists the last ten,
  so cold starts can be reported separately from normal response times. Every response
  also carries a `Server-Timing: app;dur=<ms>` header.
- A running replay continues after a restart.

## When something is wrong

| Symptom | Likely cause |
| --- | --- |
| Build fails installing scikit-learn | Python version: keep `.python-version` at the repo root with `3.13` |
| `system/check` shows `database.ok: false`, "Network is unreachable" | Direct Supabase string (IPv6); use the Session pooler string |
| `model.loaded: false` | The model files or `requirements.txt` changed; the error names which check failed |
| Kits get `401` | Wrong key, or the key belongs to the other machine; rotate with `seed --rotate-keys` |
| Kits get `409` repeatedly | The firmware does not increase `sequence`, or reuses `session_id` after a reboot |
