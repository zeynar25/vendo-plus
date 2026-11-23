# Vendo+ backend

FastAPI service that receives the kits' readings, predicts restock urgency with
the trained model, and serves the operator dashboard. It runs on Render
(see `../render.yaml` and `../docs/backend-deploy.md`).

## Run locally

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
python -m pip install -r requirements-dev.txt
python -m pytest
uvicorn app.main:app --reload
```

Then open http://127.0.0.1:8000/healthz and http://127.0.0.1:8000/docs.
