// Checks the hopper chooser on the Compartment detail and Refill and history pages.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load");

function fresh() {
  const V = load(["dom.js", "format.js", "sample-data.js", "views/overview.js", "views/hoppers.js", "views/detail.js", "views/refills.js"]);
  V.state = { selectedId: null };
  V.resetSample("live");
  return V;
}

function links(html, page) {
  return Array.from(html.matchAll(new RegExp('href="#/' + page + '/(\\d+)"', "g")), (m) => Number(m[1]));
}

for (const page of ["compartment", "refills"]) {
  test(page + " page without a hopper id asks which hopper, with a link to each one", async () => {
    const V = fresh();
    const data = await V.views[page].load({ name: page, id: null });
    assert.equal(data.entry, null);
    const html = V.views[page].render(data);
    const status = await V.api.getStatus();
    const ids = Array.from(V.hopperList(status), (x) => x.compartment.id);
    assert.equal(ids.length, 3);
    assert.deepEqual(links(html, page).sort(), ids.slice().sort());
    assert.match(html, /Choose a hopper/);
    assert.doesNotMatch(html, /There is no hopper/);
  });

  test(page + " page with a hopper id opens that hopper and shows the switcher", async () => {
    const V = fresh();
    const status = await V.api.getStatus();
    const target = V.hopperList(status)[1].compartment;
    const data = await V.views[page].load({ name: page, id: target.id });
    assert.equal(data.entry.compartment.id, target.id);
    assert.equal(V.state.selectedId, target.id);
    const html = V.views[page].render(data);
    assert.doesNotMatch(html, /Choose a hopper/);
    assert.match(html, /class="hopper-switch"/);
    assert.match(html, new RegExp('href="#/' + page + "/" + target.id + '" aria-current="page"'));
    assert.equal(links(html, page).length, 3);
  });

  test(page + " page with an unknown hopper id says so and asks which hopper", async () => {
    const V = fresh();
    const data = await V.views[page].load({ name: page, id: 999 });
    assert.equal(data.entry, null);
    const html = V.views[page].render(data);
    assert.match(html, /There is no hopper with id 999/);
    assert.equal(links(html, page).length, 3);
  });
}

test("the chooser marks the hopper viewed last", async () => {
  const V = fresh();
  const status = await V.api.getStatus();
  const target = V.hopperList(status)[2].compartment;
  await V.views.compartment.load({ name: "compartment", id: target.id });
  const html = V.views.refills.render(await V.views.refills.load({ name: "refills", id: null }));
  const card = html.split("<li ").find((s) => s.includes('href="#/refills/' + target.id + '"'));
  assert.match(card, /Last viewed/);
  assert.equal((html.match(/Last viewed/g) || []).length, 1);
});

test("hoppers keep one order by id (coffee, milk, chocolate), whatever the urgency ranking", async () => {
  const V = fresh();
  const status = await V.api.getStatus();
  const ranked = Array.from(status.machines[0].compartments, (c) => c.code);
  assert.notDeepEqual(ranked, ["coffee", "milk", "chocolate"]); // the overview order differs
  assert.deepEqual(Array.from(V.hopperList(status), (x) => x.compartment.code), ["coffee", "milk", "chocolate"]);
});

test("the switcher shows short names in the same fixed order", async () => {
  const V = fresh();
  const status = await V.api.getStatus();
  const html = V.hopperSwitch(status, "refills", 2);
  assert.deepEqual(Array.from(html.matchAll(/">([^<]+)<\/a>/g), (m) => m[1]), ["Coffee", "Milk", "Chocolate"]);
});

test("an offline machine's hoppers can be chosen, with their stock hidden", () => {
  const V = fresh();
  const html = V.hopperChooser(
    { machines: [{ id: "coffee-01", name: "Coffee machine", online: false, compartments: [{ id: 1, code: "C1", name: "Coffee", value: 120, unit: "g" }] }] },
    "compartment",
  );
  assert.match(html, /coffee-01 is offline/);
  assert.match(html, /href="#\/compartment\/1"/);
  assert.doesNotMatch(html, /120/);
});

test("the overview's hopper names link straight to the hopper's detail", async () => {
  const V = fresh();
  const status = await V.api.getStatus();
  const html = V.views.overview.render(status);
  const ids = Array.from(V.hopperList(status), (x) => x.compartment.id);
  assert.deepEqual(links(html, "compartment").sort(), ids.slice().sort());
});

test("in replay mode the chooser marks the stock values as replayed, not live", async () => {
  const V = fresh();
  V.resetSample("replay");
  const html = V.views.compartment.render(await V.views.compartment.load({ name: "compartment", id: null }));
  assert.match(html, /Replayed from sales records, not live/);
});
