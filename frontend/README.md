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
| `js/views/overview.js`, `css/overview.css` | Overview: the ranked compartment rows of each machine |
| `tests/` | Checks for the sample data and formatting (`node --test "frontend/tests/*.test.js"` from the repository root, Node 18 or later) |

## Sample data

There is no live backend yet, so the dashboard reads static sample data shaped
exactly like the responses in `docs/api-contract.md`. All values are synthetic.
Choose a scenario with `?scenario=` in the address bar, for example
`index.html?scenario=replay#/overview`:

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
