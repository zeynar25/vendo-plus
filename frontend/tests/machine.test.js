// Checks the mock machine's kit logic against Table 3 and docs/api-contract.md.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load");

const kit = (extra) => load(["config.js", "machine/kit.js"], Object.assign({ AbortController }, extra)).kit;

test("the drinks and grams are Table 3, recipe version R2", () => {
  const K = kit();
  const table = {};
  K.DRINKS.forEach((d) => (table[d.name] = [d.grams.coffee, d.grams.milk, d.grams.chocolate]));
  assert.equal(
    JSON.stringify(table),
    JSON.stringify({
      Espresso: [7, 0, 0],
      Americano: [7, 0, 0],
      "Americano with Milk": [7, 6, 0],
      Cortado: [7, 6, 0],
      Cappuccino: [7, 10, 0],
      Latte: [7, 12, 0],
      Cocoa: [0, 6, 20],
      "Hot Chocolate": [0, 8, 20],
    })
  );
  const assumed = K.DRINKS.filter((d) => d.assumed.length).map((d) => d.name + ":" + d.assumed.join());
  assert.equal(assumed.join(" "), "Cortado:milk Cocoa:milk Hot Chocolate:milk");
});

test("drink wording and shortfall", () => {
  const K = kit();
  assert.equal(K.withArticle("Americano"), "an Americano");
  assert.equal(K.withArticle("Latte"), "a Latte");
  assert.equal(K.recipeText(K.drink("latte")), "7 g coffee and 12 g milk");
  assert.equal(K.recipeText(K.drink("hot-chocolate")), "8 g milk and 20 g chocolate");
  assert.equal(K.shortfall(K.drink("latte"), { coffee: 7, milk: 12, chocolate: 0 }), null);
  assert.equal(
    JSON.stringify(K.shortfall(K.drink("latte"), { coffee: 50, milk: 11.5, chocolate: 0 })),
    JSON.stringify({ code: "milk", need: 12, have: 11.5 })
  );
});

test("status ranges follow the firmware", () => {
  const K = kit();
  const c = (g) => `${K.classify(g).status}:${K.classify(g).value}`;
  assert.equal(c(-10.5), "out_of_range:null");
  assert.equal(c(-10), "corrected_zero:0");
  assert.equal(c(-2.4), "corrected_zero:0");
  assert.equal(c(0), "ok:0");
  assert.equal(c(512.44), "ok:512.4");
  assert.equal(c(1000), "ok:1000");
  assert.equal(c(1002.4), "over_capacity:1002.4");
  assert.equal(c(1050), "over_capacity:1050");
  assert.equal(c(1052.4), "out_of_range:null");
  assert.equal(c(null), "unavailable:null");
});

test("a reading is the median of five noisy samples, in steps of 1 / 0.42 g", () => {
  const K = kit();
  const still = () => 0.5;
  // no noise: 840 g on the cell is 352.8 counts, rounded to 353; (353 - 84) / 0.42 = 640.48
  const noNoise = load(["machine/kit.js"]).kit;
  noNoise.gauss = () => 0;
  const r = noNoise.read({ mass: 640, connected: true }, still);
  assert.equal(r.status, "ok");
  assert.equal(r.value, 640.5);
  // one spike among five samples does not move the median
  let i = 0;
  noNoise.gauss = () => (i++ === 2 ? 100 : 0);
  assert.equal(noNoise.read({ mass: 640, connected: true }, still).value, 640.5);
  // every reading sits on the conversion grid
  for (let n = 0; n < 50; n++) {
    const x = K.read({ mass: 250, connected: true }, Math.random);
    const counts = x.grams * K.COUNTS_PER_G;
    assert.ok(Math.abs(counts - Math.round(counts)) < 0.05, "off grid: " + x.grams);
    assert.ok(Math.abs(x.grams - 250) <= 3 * (1 / K.COUNTS_PER_G), "too far: " + x.grams);
  }
  // an unplugged sensor is unavailable with no value
  assert.equal(JSON.stringify(K.read({ mass: 640, connected: false }, Math.random)), JSON.stringify({ value: null, status: "unavailable", grams: null }));
});

test("batches match the contract and the sequence moves on even if a batch fails", () => {
  const K = kit();
  const session = { id: K.newSessionId((n) => Uint8Array.from({ length: n }, (_, i) => i * 37)), sequence: 0 };
  assert.match(session.id, /^[0-9a-f]{12}$/);
  const readings = {
    coffee: { value: 512.4, status: "ok" },
    milk: { value: 0, status: "corrected_zero" },
    chocolate: { value: null, status: "unavailable" },
  };
  const first = K.buildBatch(session, readings, new Date("2026-11-19T14:05:00.123Z"));
  assert.equal(
    JSON.stringify(first),
    JSON.stringify({
      machine_id: "coffee-01",
      session_id: session.id,
      sequence: 0,
      device_time: "2026-11-19T14:05:00Z",
      readings: [
        { compartment: "coffee", value: 512.4, status: "ok", calibration_version: 1 },
        { compartment: "milk", value: 0, status: "corrected_zero", calibration_version: 1 },
        { compartment: "chocolate", value: null, status: "unavailable", calibration_version: 1 },
      ],
    })
  );
  assert.equal(K.buildBatch(session, readings, new Date()).sequence, 1);
  assert.equal(session.sequence, 2);
});

test("serial-only until the address is real and a device key is entered", () => {
  const K = kit();
  assert.equal(K.target("https://vendoplus-backend.example.invalid", "abc").reason, "placeholder");
  assert.equal(K.target("http://127.0.0.1:8000", "").reason, "no_key");
  const t = K.target("http://127.0.0.1:8000/", "abc");
  assert.equal(t.serial, false);
  assert.equal(t.url, "http://127.0.0.1:8000/api/v1/readings");
});

const reply = (status, body) =>
  Promise.resolve({ status, statusText: "", json: () => Promise.resolve(body) });

test("sending posts JSON with X-Device-Key and reads every reply", async () => {
  const calls = [];
  const replies = [
    reply(201, { batch_id: 41, accepted: 3, machine_mode: "live" }),
    reply(401, { detail: "missing or wrong device key" }),
    reply(409, { detail: "duplicate batch" }),
    reply(422, { detail: [{ loc: ["body", "readings"], msg: "too long" }] }),
    reply(201, { batch_id: 42, accepted: 3, machine_mode: "replay" }),
    Promise.reject(new TypeError("Failed to fetch")),
  ];
  const fetch = (url, opts) => {
    calls.push({ url, opts });
    return replies.shift();
  };
  const K = kit({ fetch });
  const batch = { machine_id: "coffee-01", session_id: "s", sequence: 0, readings: [] };
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await K.post("http://127.0.0.1:8000/api/v1/readings", "key-1", batch, fetch, 1000));

  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers["X-Device-Key"], "key-1");
  assert.equal(calls[0].opts.headers["Content-Type"], "application/json");
  assert.equal(calls[0].opts.body, JSON.stringify(batch));

  const t = { serial: false };
  assert.deepEqual(
    results.map((r) => K.describe(r, t).title),
    ["201 Accepted", "401 Rejected", "409 Rejected", "422 Rejected", "201 Accepted", "Not delivered"]
  );
  assert.equal(K.describe(results[0], t).text, "Stored 3 readings as batch 41.");
  assert.equal(K.describe(results[3], t).text, "body.readings: too long");
  assert.match(K.describe(results[4], t).text, /replay mode/);
  assert.match(K.describe(results[5], t).text, /newest state/);
  assert.equal(K.describe(null, { serial: true, reason: "no_key" }).title, "Serial only");
});
