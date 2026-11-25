// Checks how the start-up window decides whether the backend is awake.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load");

const S = () => load(["config.js", "startup.js"], { AbortController, setTimeout, clearTimeout }).startup;

const reply = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => body });
const okJson = (body) => reply(200, Promise.resolve(body));
const htmlPage = () => reply(200, Promise.reject(new SyntaxError("Unexpected token <")));

test("addresses: base, placeholder, host", () => {
  const s = S();
  assert.equal(s.baseUrl({ API_BASE_URL: " https://vendoplus-backend.onrender.com/ " }), "https://vendoplus-backend.onrender.com");
  assert.equal(s.isPlaceholder("https://vendoplus-backend.example.invalid"), true);
  assert.equal(s.isPlaceholder("https://vendoplus-backend.onrender.com"), false);
  assert.equal(s.isPlaceholder("http://127.0.0.1:8000"), false);
  assert.equal(s.hostOf("https://vendoplus-backend.onrender.com"), "vendoplus-backend.onrender.com");
  assert.equal(s.formatElapsed(83000), "1:23");
  assert.equal(s.formatElapsed(5000), "0:05");
});

test("awake: /healthz says ok, then the system check is read", async () => {
  const s = S();
  const urls = [];
  const fetch = (url, opts) => {
    urls.push(url);
    assert.equal(Object.keys(opts.headers).join(), "Accept"); // a simple request: no CORS preflight
    return url.endsWith("/healthz")
      ? okJson({ status: "ok", version: "0.1.0" })
      : okJson({ ready: true, database: { ok: true }, model: { loaded: true, algorithm: "random_forest", sha256: "98e0efe8abc" } });
  };
  const r = await s.probe("https://b.example", fetch, 1000);
  assert.equal(r.awake, true);
  assert.deepEqual(urls, ["https://b.example/healthz", "https://b.example/api/v1/system/check"]);
  const sum = s.summarize(r.check);
  assert.equal(sum.ready, true);
  assert.equal(sum.model.sha, "98e0efe8");
});

test("still waking: failed requests, loading pages, and error codes", async () => {
  const s = S();
  const cases = [
    [() => Promise.reject(new TypeError("Failed to fetch")), "no_answer"], // includes a CORS-less loading page
    [() => htmlPage(), "not_ready"], // Render's loading page instead of JSON
    [() => reply(503, Promise.resolve({})), "status_503"],
    [() => okJson({ status: "starting" }), "not_ready"],
  ];
  for (const [fetch, reason] of cases) {
    const r = await s.probe("https://b.example", fetch, 1000);
    assert.equal(r.awake, false);
    assert.equal(r.reason, reason);
  }
});

test("a request held too long counts as a timeout, not as awake", async () => {
  const s = S();
  const fetch = (url, opts) =>
    new Promise((resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  const r = await s.probe("https://b.example", fetch, 30);
  assert.deepEqual([r.awake, r.reason], [false, "timeout"]);
});

test("awake but not ready: the window reports the database or the model", async () => {
  const s = S();
  const fetch = (url) =>
    url.endsWith("/healthz")
      ? okJson({ status: "ok" })
      : okJson({ ready: false, database: { ok: false, error: "OperationalError: no route" }, model: { loaded: true, algorithm: "random_forest" } });
  const sum = s.summarize((await s.probe("https://b.example", fetch, 1000)).check);
  assert.equal(sum.ready, false);
  assert.equal(sum.database.ok, false);
  assert.match(sum.database.error, /OperationalError/);
  // If the system check itself cannot be read, the health answer is enough.
  const noCheck = await s.probe("https://b.example", (url) => (url.endsWith("/healthz") ? okJson({ status: "ok" }) : Promise.reject(new TypeError("x"))), 1000);
  assert.equal(noCheck.awake, true);
  assert.equal(s.summarize(noCheck.check).ready, true);
});
