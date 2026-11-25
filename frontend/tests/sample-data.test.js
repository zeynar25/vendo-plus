// Checks that the sample data keeps the API contract's shape and rules.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load");

const V = load(["format.js", "sample-data.js"]);

const COMPARTMENT_FIELDS = [
  "id", "code", "name", "unit", "capacity", "value", "percent", "status", "calibration_version",
  "reading_age_s", "stale", "label", "method", "reason", "acknowledged", "refill_open", "unrecorded_refill_id",
];

test("status has the contract's machine and compartment fields", async () => {
  V.resetSample("live");
  const status = await V.api.getStatus();
  const m = status.machines[0];
  for (const f of ["id", "name", "kind", "mode", "online", "last_reading_age_s", "replay", "compartments"]) {
    assert.ok(f in m, f);
  }
  assert.equal(m.id, "coffee-01");
  assert.equal(m.compartments.length, 3);
  for (const c of m.compartments) {
    assert.deepEqual(Object.keys(c).sort(), COMPARTMENT_FIELDS.slice().sort());
  }
});

test("compartments are ranked High, Medium, Low, then by lower percentage", () => {
  const ranked = V.rankCompartments([
    { label: "Low", percent: 10 },
    { label: null, percent: 1 },
    { label: "High", percent: 30 },
    { label: "Medium", percent: 40 },
    { label: "Medium", percent: 15 },
  ]);
  assert.deepEqual(Array.from(ranked, (c) => `${c.label}${c.percent}`), ["High30", "Medium15", "Medium40", "Low10", "null1"]);
});

test("the basic stock warning uses 5 % and 20 %", () => {
  assert.equal(V.basicLabel(5), "High");
  assert.equal(V.basicLabel(5.1), "Medium");
  assert.equal(V.basicLabel(20), "Medium");
  assert.equal(V.basicLabel(20.1), "Low");
});

test("each scenario matches its Figma frame", async () => {
  V.resetSample("replay");
  let m = (await V.api.getStatus()).machines[0];
  assert.equal(m.mode, "replay");
  assert.equal(m.replay.speed, 60);
  assert.deepEqual(Array.from(m.compartments, (c) => c.code), ["milk", "chocolate", "coffee"]);

  V.resetSample("history");
  m = (await V.api.getStatus()).machines[0];
  assert.ok(m.compartments.every((c) => c.method === "basic" && c.reason === "history_short" && c.stale));
  assert.equal(m.online, true);
  const detail = await V.api.getCompartment(2);
  assert.equal(detail.consumption_per_hour, null);
});

test("offline and sensor scenarios follow the contract's rules", async () => {
  V.resetSample("offline");
  let m = (await V.api.getStatus()).machines[0];
  assert.equal(m.online, false); // no valid reading for more than 15 s

  V.resetSample("sensors");
  m = (await V.api.getStatus()).machines[0];
  const byCode = Object.fromEntries(Array.from(m.compartments, (c) => [c.code, c]));
  assert.equal(byCode.chocolate.value, null);
  assert.equal(byCode.chocolate.reason, "invalid_reading");
  assert.equal(byCode.coffee.status, "over_capacity");
  assert.equal(byCode.coffee.label, null); // over capacity never drives urgency
  assert.equal(m.compartments[0].code, "milk"); // labeled rows rank first
});

test("acknowledging hides only Medium and High alerts", async () => {
  V.resetSample("live");
  await V.api.acknowledge(2);
  const milk = (await V.api.getStatus()).machines[0].compartments.find((c) => c.code === "milk");
  assert.equal(milk.acknowledged, true);
  assert.equal(milk.value, 48); // stock never changes
  await assert.rejects(V.api.acknowledge(1), (e) => e.status === 409);
});

test("a refill waits for a stable reading, then records before, after, and amount added", async () => {
  V.resetSample("live");
  await assert.rejects(V.api.startRefill(2), (e) => e.status === 409 && e.detail === "not stable");
  await assert.rejects(V.api.startRefill(2), (e) => e.detail === "not stable");
  const started = await V.api.startRefill(2);
  assert.equal(started.before_value, 48);
  const open = (await V.api.getStatus()).machines[0].compartments.find((c) => c.code === "milk");
  assert.equal(open.refill_open, true);
  assert.equal(open.label, null);
  assert.equal(open.reason, "refill_open");
  await assert.rejects(V.api.endRefill(2), (e) => e.detail === "not stable");
  await assert.rejects(V.api.endRefill(2), (e) => e.detail === "not stable");
  const ended = await V.api.endRefill(2);
  assert.equal(ended.added, ended.after_value - 48);
  const history = await V.api.getRefills(2);
  assert.equal(history.refills[0].id, ended.refill_id);
});

test("refill mode is refused during replay", async () => {
  V.resetSample("replay");
  await assert.rejects(V.api.startRefill(2), (e) => e.status === 409 && /replay/.test(e.detail));
});

test("reconciling an unrecorded refill adds it to the history", async () => {
  V.resetSample("live");
  const before = await V.api.getRefills(2);
  const reset = before.unrecorded_refills[0];
  await V.api.reconcile(reset.history_reset_id);
  const after = await V.api.getRefills(2);
  assert.equal(after.unrecorded_refills.length, 0);
  assert.ok(after.refills.some((r) => r.kind === "reconciled" && r.added === reset.jump));
});

test("formatting puts a unit on every number", () => {
  assert.equal(V.fmt.amount(48), "48 g");
  assert.equal(V.fmt.amount(1000), "1,000 g");
  assert.equal(V.fmt.percent(4.8), "4.8 %");
  assert.equal(V.fmt.added(840), "+840 g");
  assert.equal(V.fmt.age(3.4), "3 s");
  assert.equal(V.fmt.rate(null), "— g/h");
  assert.equal(V.fmt.fullTime("2025-01-14T09:30:00+08:00"), "14 Jan 2025, 09:30");
});
