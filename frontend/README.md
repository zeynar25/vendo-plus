# Vendo+ operator dashboard

The web page the operator uses to see which coffee hopper needs a refill first.
It follows the Figma file *Vendo+ Operator Dashboard* and reads everything through
`docs/api-contract.md`.

Plain HTML, CSS, and JavaScript: no framework, no build step, nothing to install.

## Run it

Open `frontend/index.html` in a browser. To serve it instead (closer to how
Vercel serves it, see "Deploy on Vercel" below):

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
| `js/startup.js`, `css/startup.css` | The start-up window that waits for a sleeping backend to wake (see below) |
| `js/views/overview.js`, `css/overview.css` | Overview: the ranked compartment rows of each machine |
| `js/views/hoppers.js`, `css/hoppers.css` | Choosing a hopper: the chooser on the detail and refill pages, and the hopper switcher |
| `js/views/detail.js`, `css/detail.css` | Compartment detail: 24-hour chart, consumption rate, calibration, recent alerts |
| `js/views/refills.js`, `css/refills.css` | Refill and history: refill mode, stable readings, past refills, reconciling |
| `machine.html`, `css/machine.css` | Mock coffee machine: the offline stand-in for the Wokwi kit (see below) |
| `js/machine/kit.js` | The mock kit's logic: Table 3 recipes, simulated load cell readings, batches, sending |
| `js/machine/page.js` | The mock machine page: drink buttons, brewing, pickup slot, hoppers, kit log |
| `tests/` | Checks for the sample data, formatting, the mock kit, the start-up check, and the hopper chooser (`node --test "frontend/tests/*.test.js"` from the repository root, Node 18 or later) |

## Pages and choosing a hopper

| Address | What it shows |
| --- | --- |
| `#/overview` | Every hopper, ranked from High to Low urgency |
| `#/compartment` | "Which hopper?" first, then that hopper's detail |
| `#/compartment/<id>` | The detail of hopper `<id>` straight away |
| `#/refills` | "Which hopper?" first, then that hopper's refill mode and history |
| `#/refills/<id>` | The refill mode and history of hopper `<id>` straight away |

- The **Compartment detail** and **Refill and history** tabs in the header
  always open the chooser: one card per hopper with its stock, urgency, and
  reading age. The card of the hopper opened last is marked "Last viewed".
- Clicking a hopper's name on the overview skips the chooser and opens that
  hopper's detail.
- On a hopper's page, the **Hopper** switcher in the title row (Coffee, Milk,
  Chocolate) changes hopper and stays on the same page.
- Hoppers keep one fixed order (coffee, milk, chocolate) in the chooser and the
  switcher, so nothing moves under the pointer while the page refreshes.
- An address with a hopper id that does not exist shows the chooser with a
  note, instead of silently showing another hopper.

## Backend

The dashboard reads from the backends set in `js/config.js`:

```js
API_BASE_URL: "https://vendoplus-backend.onrender.com", // the deployed backend
LOCAL_API_BASE_URL: "http://127.0.0.1:8000",              // the backend on this computer
OPERATOR_KEY: "",
```

- No trailing slash. The page always asks the online backend first.
  `LOCAL_API_BASE_URL` is the fallback for a demo without internet (see "Online
  first, then this computer" below); set it to `""` to turn the fallback off.
- The backend's `CORS_ORIGINS` setting must allow the page's address;
  `render.yaml` sets `*`, which allows any address.
- Leave `OPERATOR_KEY` empty unless the backend's `OPERATOR_KEY` is set. Never
  commit a real key.

### Online first, then this computer

The page uses one backend at a time, and says which:

| Situation | What the page does |
| --- | --- |
| The online backend answers (even after waking for a minute) | Uses it |
| The browser reports no network, or the online backend can't be reached at all, and the backend on this computer answers | Switches to this computer by itself and says why |
| You press **Use the backend on this computer** in the start-up window | Switches to this computer; if it isn't running yet, shows the command to start it and connects as soon as it answers |
| The address has `?backend=local` (for example `index.html?backend=local`) | Starts on this computer straight away |

A sleeping Render service is never mistaken for "no internet": while it wakes it
still answers (with a loading page) or holds the request. The page tells the two
apart with a plain `no-cors` request to the online backend, which fails only when
nothing on the internet can be reached. So a normal one-minute wake-up never
switches to this computer, even when a local backend is running.

While the page uses this computer, the line under the header says so ("Its data is
separate from the online backend's") with **Go back to the online backend**, which
reloads the page asking the online backend first; on the mock machine the same
button is in the Kit card. The two databases are separate: readings, refills, and
device keys on one are not on the other. The mock machine therefore keeps one
device key per backend address and picks the right one after a switch.

On the Vercel page, switching to this computer needs the backend running on the
same laptop as the browser; the browser may ask whether the site may reach devices
on your local network. Without internet the Vercel page can't load at all, so for
an offline demo open the local `frontend/index.html` instead.

### The start-up window

The backend runs on Render's free plan, which puts it to sleep after 15 minutes
without traffic; the next request wakes it, which takes about a minute. So when
`index.html` or `machine.html` opens, `js/startup.js` asks the backend's
`/healthz` and then `/api/v1/system/check`:

| What happens | What the window does |
| --- | --- |
| The backend answers within 0.8 s (already awake) | Nothing: it never appears |
| No answer yet, or Render's loading page instead of JSON | "Waking up the server": a picture of the sleeping, waking, and ready server, a short explanation of the free plan, the time waited, and three steps. It asks again every 3 s and closes by itself once the backend answers |
| Still no answer after 2.5 minutes | "Still waking up the server", with "Use sample data instead" first |
| The backend answers but its check fails (database or model) | "The server is awake, but not ready", with the reason, "Check again", and "Open the dashboard anyway" |
| The computer is offline | "You're offline"; checks again when the connection returns |
| `API_BASE_URL` is the `.invalid` placeholder | "The backend address isn't set" |
| No internet and nothing answers on this computer | "No internet, and no backend on this computer", with the command to start it |

"Close and wait in the dashboard" only hides the window: it keeps checking, and
the dashboard refreshes by itself once the backend is awake. While it waits, the
line above the page says "Waking the backend" rather than "Can't reach the
backend". With `?data=sample` there is no server to wake, so the window does not
run.

## Deploy on Vercel

The dashboard is static files with no build step, so Vercel serves it as is,
from a CDN, without the dashboard itself ever sleeping. Only the backend on
Render sleeps, and the start-up window covers that.

1. Make sure `js/config.js` has the backend's address (it does:
   `https://vendoplus-backend.onrender.com`) and push the repository to GitHub.
2. On vercel.com, choose **Add New → Project** and import the repository.
3. In **Configure Project**:
   - **Root Directory:** click **Edit** and choose `frontend`.
   - **Framework Preset:** **Other**.
   - **Build Command:** leave it empty. **Output Directory:** leave the default;
     with "Other" and no `public` folder, Vercel serves the root directory,
     which is `frontend`.
   - No environment variables are needed: the page reads `js/config.js`.
4. Click **Deploy**. The dashboard is at the project's address (for example
   `https://<project>.vercel.app/`) and the mock coffee machine at
   `/machine.html`.
5. Every push to the deployed branch redeploys it.

Optional: to let only the Vercel address call the backend, set `CORS_ORIGINS`
to that address (no trailing slash; separate several addresses with commas, for
example `https://<project>.vercel.app,http://localhost:5173`). Change it in
`render.yaml` and push, rather than in the Render dashboard, because the
Blueprint manages that value. Keeping `*` also works for the prototype.

For a demo without internet, open the local files instead of the Vercel address
and follow "Running it without internet" below.

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

## Mock coffee machine (offline fail-safe)

`machine.html` stands in for the Wokwi kit when a demonstration has no internet
and the online Wokwi project cannot run. It is a simulated `coffee-01` that runs
in the browser:

- eight drink buttons with the grams of Table 3 in the paper (recipe version R2);
  making a drink takes about 4.5 s and takes those grams from the hoppers;
- clicking the finished cup shows "This is an Americano." (or the drink made);
- three hoppers (coffee, milk, chocolate) on load cells, each with an HX711
  display of the grams the kit reads, a load control like the one in Wokwi, a
  "Fill to 1,000 g" button, and a "Sensor connected" switch;
- a kit that sends one batch with the three readings to `POST /api/v1/readings`
  every 5 seconds, exactly as `docs/api-contract.md` describes, and a log of every
  batch (the JSON sent and the backend's reply) and every machine event.

The cup message is an in-page dialog rather than the browser's `alert()`, because
a native alert pauses the page's timers and would stop the 5-second batches while
it is open.

### Running it without internet

Without internet the backend on Render cannot be reached either, so the page
switches to the backend on the presenting laptop (see "Online first, then this
computer" above). Prepare the laptop while you still have internet:

```bash
cd backend
python -m pip install -r requirements-dev.txt   # in backend/.venv
python -m app.cli seed            # once, without DATABASE_URL set: prints the local coffee-01 key
uvicorn app.main:app              # http://127.0.0.1:8000; stop with Ctrl+C
```

Write down the local `coffee-01` key: it is not the same as the Supabase one. Then
test once with Wi-Fi off.

On the day, without internet:

1. Start the backend: in `backend/`, activate `.venv` and run `uvicorn app.main:app`.
2. Open the local `frontend/index.html` and `frontend/machine.html` (not the
   Vercel address). Each says "Using the backend on this computer". If you open
   them before starting the backend, the start-up window shows the command and
   connects as soon as the backend answers.
3. On the machine page, paste the local device key and press **Save**. The mode
   changes from "Serial only" to "Sending", and each batch shows `201 Accepted`.
4. A fresh local database has no history, and the model needs 24 hours of it, so
   live mock-machine readings show the basic stock warning. To show model
   urgencies, start replay mode: open `http://127.0.0.1:8000/docs`,
   **POST /api/v1/machines/{machine_id}/replay/start** with `coffee-01` and, for
   example, this body (it stores 24 hours of history first, then plays one hour
   of sales per minute):
   ```json
   {"source_start": "2025-01-15T07:00:00", "initial_stock_g": {"coffee": 150, "milk": 150, "chocolate": 100}, "speed": 60}
   ```

Keep the machine page in its own window rather than a background tab: browsers
slow down timers in hidden tabs. Keys are saved only in that browser
(`localStorage`), one per backend address; never commit them. If the local key is
lost, `python -m app.cli seed --rotate-keys` (again without `DATABASE_URL`) issues
a new one.

Until a key is entered, or while `API_BASE_URL` is the placeholder, the kit runs
serial-only like the public Wokwi project: batches appear in the log but are not
sent.

### What it simulates

Everything on this page is simulated, and ingredient use is the recipe amount,
not measured consumption. The page lists its assumptions under "What this mock
simulates":

| Item | Value | Source |
| --- | --- | --- |
| Grams per drink | Table 3, recipe version R2 (about 150 ml cups) | Paper; `ml/config.py` |
| Hopper capacity, empty container | 1,000 g, 200 g | Paper (experimental assumptions) |
| Reading | Median of 5 raw samples, each with Gaussian noise of 2 g SD | Paper (sensing check) |
| Conversion | 0.42 counts per gram, so readings move in steps of about 2.38 g | Paper (sensing results) |
| Status ranges | Below −10 g or above 1,050 g rejected (null); −10 to 0 g sent as 0; above 1,000 g `over_capacity` | Contract |
| Batches | Every 5 s; new session ID at each start (page load or power on); a failed batch is not resent | Contract |
| Brewing time | 1.5 s dispensing, 3 s brewing | Mock choice |
| Starting loads | 640 g coffee, 180 g milk, 420 g chocolate on first use; afterwards kept in the browser | Mock choice (arbitrary) |

A rise of more than 20 g outside refill mode (the load control or "Fill to
1,000 g") is recorded by the backend as an unrecorded refill, as it would be
with the Wokwi kit. To show a recorded refill, start refill mode on the
dashboard first, fill the hopper on the machine page, then end refill mode.

When presenting with this page, say that the readings come from the mock
machine and not from the Wokwi kit.
