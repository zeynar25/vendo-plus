// Checks that the HTTP client calls the contract's endpoints at the configured address.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load");

function setup(responder, config) {
  const calls = [];
  const fetch = (url, opts) => {
    calls.push({ url, method: opts.method, headers: opts.headers });
    return responder(url, opts);
  };
  const V = load(["dom.js", "format.js", "sample-data.js", "config.js", "api.js"], { fetch, AbortController });
  Object.assign(V.config, config || {});
  return { V, calls };
}

const json = (status, body) =>
  Promise.resolve({ ok: status < 400, status, statusText: "", json: () => Promise.resolve(body) });

test("the backend is used by default, at the deployed Render address", async () => {
  const { V, calls } = setup(() => json(200, { server_time: "", machines: [] }));
  assert.equal(V.api, V.httpApi);
  assert.equal(V.config.API_BASE_URL, "https://vendoplus-backend.onrender.com");
  await V.api.getStatus();
  assert.equal(calls[0].url, "https://vendoplus-backend.onrender.com/api/v1/status");
  assert.equal(calls[0].method, "GET");
});

test("operator actions are POSTs to the contract's paths", async () => {
  const { V, calls } = setup(() => json(200, {}), { API_BASE_URL: "http://127.0.0.1:8000/" });
  await V.api.acknowledge(2);
  await V.api.startRefill(2);
  await V.api.endRefill(2);
  await V.api.cancelRefill(2);
  await V.api.reconcile(7);
  await V.api.getCompartment(2);
  await V.api.getRefills(2);
  assert.deepEqual(
    calls.map((c) => c.method + " " + c.url.replace("http://127.0.0.1:8000", "")),
    [
      "POST /api/v1/compartments/2/acknowledge",
      "POST /api/v1/compartments/2/refill/start",
      "POST /api/v1/compartments/2/refill/end",
      "POST /api/v1/compartments/2/refill/cancel",
      "POST /api/v1/history-resets/7/reconcile",
      "GET /api/v1/compartments/2",
      "GET /api/v1/compartments/2/refills",
    ]
  );
});

test("the operator key is sent only on actions, and only when set", async () => {
  let r = setup(() => json(200, {}));
  await r.V.api.acknowledge(2);
  assert.equal(r.calls[0].headers["X-Operator-Key"], undefined);
  r = setup(() => json(200, {}), { OPERATOR_KEY: "k" });
  await r.V.api.getStatus();
  await r.V.api.acknowledge(2);
  assert.equal(r.calls[0].headers["X-Operator-Key"], undefined);
  assert.equal(r.calls[1].headers["X-Operator-Key"], "k");
});

test("a 409 keeps the backend's detail, so the refill view can retry on 'not stable'", async () => {
  const { V } = setup(() => json(409, { detail: "not stable" }));
  await assert.rejects(V.api.startRefill(2), (e) => e.status === 409 && e.detail === "not stable");
});

test("an unreachable backend is reported and retried every 10 s, not every 2 s", async () => {
  const { V, calls } = setup(() => Promise.reject(new TypeError("fetch failed")));
  await assert.rejects(V.api.getStatus(), (e) => e.status === 0);
  assert.equal(V.connection.state, "unreachable");
  await assert.rejects(V.api.getStatus(), (e) => e.status === 0);
  assert.equal(calls.length, 1);
});
