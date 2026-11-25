/*
 * Choosing a hopper for the Compartment detail and Refill and history pages.
 *   #/compartment, #/refills         the page asks which hopper first (the chooser)
 *   #/compartment/<id>, #/refills/<id>  the page opens that hopper straight away
 * The overview's hopper names link with an id, so they skip the chooser.
 * On a hopper's page, the switcher in the title row changes hopper in one click.
 * Hoppers keep one fixed order (by id, the order they were added: coffee,
 * milk, chocolate) so nothing moves under the pointer while the page
 * refreshes every 2 s, even when the urgency ranking changes.
 */
(function (root) {
  "use strict";
  const V = (root.Vendo = root.Vendo || {});
  const esc = V.esc;

  const PAGES = {
    compartment: {
      title: "Compartment detail",
      ask: "Choose a hopper to see its 24-hour stock chart, consumption rate, calibration, and recent alerts.",
      go: "Open detail",
    },
    refills: {
      title: "Refill and history",
      ask: "Choose a hopper to start or end a refill, or to see its past refills.",
      go: "Open refills",
    },
  };

  function byId(a, b) {
    return a.id - b.id;
  }

  /** "Milk hopper" reads as "Milk" next to the switcher's "Hopper" label. */
  function shortName(name) {
    return String(name).replace(/\s+hopper$/i, "") || String(name);
  }

  /** Every hopper on the dashboard as { machine, compartment }, in a fixed order. */
  V.hopperList = function hopperList(status) {
    const all = [];
    ((status && status.machines) || []).forEach(function (m) {
      (m.compartments || []).slice().sort(byId).forEach(function (c) {
        all.push({ machine: m, compartment: c });
      });
    });
    return all;
  };

  function hrefFor(page, id) {
    return "#/" + page + "/" + encodeURIComponent(id);
  }

  function card(m, c, page) {
    const cells = V.overview.cells(c);
    const last = V.state.selectedId === c.id
      ? '<span class="pill pill--small pill--neutral hc-last">Last viewed</span>'
      : "";
    // An offline machine's stock values are hidden, as on the overview.
    const body = m.online
      ? '<span class="hc-stock">' + cells.stock + "</span>" +
        '<span class="hc-row"><span class="hc-urgency">' + cells.urgency + "</span>" +
        '<span class="hc-age">' + cells.age + "</span></span>"
      : '<span class="hc-hidden">Stock hidden while ' + esc(m.id) + " is offline</span>";
    return (
      '<li data-key="h-' + esc(c.id) + '"><a class="hc-card" href="' + hrefFor(page, c.id) + '">' +
      '<span class="hc-top"><span class="hc-title"><span class="hc-name">' + esc(c.name) + "</span>" +
      '<span class="hc-code">' + esc(c.code) + "</span></span>" + last + "</span>" + body +
      '<span class="hc-go">' + esc(PAGES[page].go) + '<span aria-hidden="true"> →</span></span></a></li>'
    );
  }

  function machineBlock(m, page) {
    const list = V.hopperList({ machines: [m] });
    const n = list.length;
    const offline = m.online
      ? ""
      : '<p class="hc-offline" role="status">' + esc(m.id) +
        " is offline, so its stock values are hidden until the kit reports again. You can still open a hopper.</p>";
    return (
      '<section class="card hc-machine" data-key="hm-' + esc(m.id) + '" aria-labelledby="hm-' + esc(m.id) + '">' +
      '<div class="machine-head"><h2 class="machine-id" id="hm-' + esc(m.id) + '">' + esc(m.id) + "</h2>" +
      '<span class="machine-kind">' + esc(m.name) + " · " + n + (n === 1 ? " hopper" : " hoppers") + "</span></div>" +
      offline +
      // Replayed stock values always carry the replay banner, as on the overview.
      (m.online && m.mode === "replay" ? '<div class="hc-replay">' + V.replayBanner(m.replay) + "</div>" : "") +
      (n
        ? '<ul class="hc-list">' + list.map(function (x) { return card(m, x.compartment, page); }).join("") + "</ul>"
        : '<p class="empty">No compartments to show.</p>') +
      "</section>"
    );
  }

  /**
   * The "which hopper?" page shown when the detail or refill page is opened
   * without a hopper id. `missingId` is set when the address named a hopper
   * that does not exist.
   */
  V.hopperChooser = function hopperChooser(status, page, missingId) {
    const p = PAGES[page];
    const machines = (status && status.machines) || [];
    const missing = missingId == null
      ? ""
      : '<p class="hc-missing" role="status">There is no hopper with id ' + esc(missingId) +
        ". Choose one of the hoppers below.</p>";
    return (
      '<div class="page-head"><h1 class="page-title">' + esc(p.title) + "</h1>" +
      '<p class="page-sub">' + esc(p.ask) + "</p></div>" + missing +
      (machines.length
        ? machines.map(function (m) { return machineBlock(m, page); }).join("")
        : '<div class="card"><p class="empty">No machines.</p></div>')
    );
  };

  /** Hopper tabs for the title row of a hopper's page: one click changes hopper and stays on the page. */
  V.hopperSwitch = function hopperSwitch(status, page, currentId) {
    const list = V.hopperList(status);
    const here = list.find(function (x) { return x.compartment.id === currentId; });
    if (!here) return "";
    const same = list.filter(function (x) { return x.machine.id === here.machine.id; });
    if (same.length < 2) return "";
    return (
      '<nav class="hopper-switch" aria-label="Hopper"><span class="hopper-switch-label" aria-hidden="true">Hopper</span>' +
      same
        .map(function (x) {
          const c = x.compartment;
          const cur = c.id === currentId ? ' aria-current="page"' : "";
          return '<a href="' + hrefFor(page, c.id) + '"' + cur + ">" + esc(shortName(c.name)) + "</a>";
        })
        .join("") +
      "</nav>"
    );
  };
})(typeof window !== "undefined" ? window : globalThis);
