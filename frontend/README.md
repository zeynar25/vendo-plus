# Vendo+ operator dashboard

The web page the operator uses to see which coffee hopper needs a refill first.
It follows the Figma file *Vendo+ Operator Dashboard* and reads everything through
`docs/api-contract.md`.

Plain HTML, CSS, and JavaScript: no framework, no build step, nothing to install.

## Run it

Open `frontend/index.html` in a browser. To serve it instead (closer to how the
backend will serve it):

```bash
cd frontend
python -m http.server 5173
# then open http://localhost:5173
```

## Files

| Path | What it holds |
| --- | --- |
| `index.html` | The page shell: header, navigation, and the script list |
| `css/tokens.css` | Colors and text styles copied from the Figma variables and text styles |
| `css/app.css` | Layout and shared components (pills, tags, buttons, cards) |
| `js/dom.js` | HTML escaping and the patch helper that updates the page without losing focus |
| `js/app.js` | Hash routes, navigation, and the 2-second refresh loop |
| `js/format.js` | Units, times, and every word shown for an API value (urgency, reasons, sensor status) |
| `js/sample-data.js` | Static sample data shaped like the API responses, and the operator actions on it |
| `js/config.js` | The backend address (`API_BASE_URL`) and the optional operator key |
| `js/api.js` | Requests to the backend, and the line that shows whether it is reachable |
| `js/views/overview.js`, `css/overview.css` | Overview: the ranked compartment rows of each machine |
| `js/views/detail.js`, `css/detail.css` | Compartment detail: 24-hour chart, consumption rate, calibration, recent alerts |
| `js/views/refills.js`, `css/refills.css` | Refill and history: refill mode, stable readings, past refills, reconciling |
| `tests/` | Checks for the sample data and formatting (`node --test "frontend/tests/*.test.js"` from the repository root, Node 18 or later) |

## Backend

The dashboard reads from the backend set in `js/config.js`:

```js
API_BASE_URL: "https://vendoplus-backend.example.invalid", // placeholder
OPERATOR_KEY: "",
```

The address is a **placeholder** until the backend is deployed (`.invalid`
never resolves), so for now the page shows "Can't reach the backend" and retries
every 10 s. When the backend is live:

1. Set `API_BASE_URL` to its Render URL, for example
   `https://vendoplus-backend.onrender.com` (no trailing slash; locally
   `http://127.0.0.1:8000`; `""` if the backend serves this page itself).
2. Check that the backend's `CORS_ORIGINS` setting allows the page's address
   (`render.yaml` sets `*`).
3. Leave `OPERATOR_KEY` empty unless the backend's `OPERATOR_KEY` is set. Never
   commit a real key.

After 15 idle minutes Render's free tier sleeps; the first request then takes
about a minute, and the page shows "Waking the backend" instead of an error.

## Sample data

Add `?data=sample` to the address to use static sample data shaped exactly like
the responses in `docs/api-contract.md`, for example while the backend is not
deployed. All values are synthetic. Choose a scenario with `&scenario=`, for
example `index.html?data=sample&scenario=replay#/overview`:

| Scenario | What it shows | Figma frames |
| --- | --- | --- |
| `live` (default) | Live mode, model urgencies, fresh readings; refill mode works | 3 to 3d (refill) |
| `replay` | Replay mode from sales records, with the replay banner | 1, 2, 3e |
| `history` | Live mode while 24 hours of history builds: basic stock warnings, readings 12 s old | 1c, 2b |
| `offline` | No valid reading for 20 s: the offline message replaces the stock values | (states table) |
| `sensors` | One hopper's sensor not ready, one reading above capacity | (states table) |

Acknowledge, refill, and reconcile change the sample data the way the backend
would, until the page is reloaded. The sample answers "not stable" twice before a
refill can start or end, so the waiting state can be seen.
