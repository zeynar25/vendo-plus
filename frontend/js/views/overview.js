/*
 * Overview (GET /api/v1/status): one panel for the coffee machine, rows ranked
 * High, Medium, Low, with ties going to the lower stock percentage. Each row
 * answers three questions at a glance: how much is left, how urgent it is, and
 * how old the reading is.
 */
(function (root) {
  "use strict";
  const V = (root.Vendo = root.Vendo || {});
  V.views = V.views || {};
  const esc = V.esc;
  const fmt = V.fmt;

  /** The urgency as a word, an icon, and a color. */
  V.urgencyPill = function urgencyPill(label) {
    const u = V.URGENCY[label];
    if (!u) return "";
    return (
      '<span class="pill pill--' + u.css + '"><span class="icon" aria-hidden="true">' + u.icon + "</span>" +
      esc(label) + "</span>"
    );
  };

  /** "Model urgency" or "Basic stock warning", marked apart. */
  V.basisTag = function basisTag(method) {
    if (method === "model") return '<span class="tag tag--model">Model urgency</span>';
    if (method === "basic") return '<span class="tag tag--basic">Basic stock warning</span>';
    return "";
  };

  V.stockBar = function stockBar(percent) {
    const width = Math.max(0, Math.min(100, percent || 0));
    return '<span class="bar" aria-hidden="true"><span style="width:' + width + '%"></span></span>';
  };

  function ageCell(c) {
    const value = c.stale
      ? '<span class="pill pill--small pill--warn">' + esc(fmt.age(c.reading_age_s)) + " · stale</span>"
      : '<span class="ov-age-value">' + esc(fmt.age(c.reading_age_s)) + "</span>";
    return '<span class="ov-age-label">Reading age</span>' + value;
  }

  V.overview = V.overview || {};

  /** Cells for a compartment with a usable reading. Later commits add more states. */
  V.overview.cells = function cells(c) {
    return {
      stock:
        '<span class="ov-value">' + esc(fmt.amount(c.value, c.unit)) + "</span>" +
        '<span class="ov-pct">' + esc(fmt.percent(c.percent)) + " of " + esc(fmt.capacity(c.capacity, c.unit)) +
        "</span>" + V.stockBar(c.percent),
      urgency: V.urgencyPill(c.label),
      basis: V.basisTag(c.method) + '<span class="ov-note">' + esc(V.basisText(c.method, c.reason)) + "</span>",
      age: ageCell(c),
      action: "",
    };
  };

  V.overview.nameCell = function nameCell(c) {
    return '<span class="ov-name">' + esc(c.name) + '</span><span class="ov-code">' + esc(c.code) + "</span>";
  };

  function row(c) {
    const cells = V.overview.cells(c);
    return (
      '<tr data-key="c-' + c.id + '">' +
      "<td>" + V.overview.nameCell(c) + "</td>" +
      "<td>" + cells.stock + "</td>" +
      "<td>" + cells.urgency + "</td>" +
      "<td>" + cells.basis + "</td>" +
      "<td>" + cells.age + "</td>" +
      "<td>" + cells.action + "</td>" +
      "</tr>"
    );
  }

  /** Extra full-width rows above the compartments (banners); later commits add them. */
  V.overview.notices = V.overview.notices || [];

  function hoppers(m) {
    const n = m.compartments.length;
    return m.name + " · " + n + (n === 1 ? " hopper" : " hoppers");
  }

  function machineMeta(m) {
    const mode = '<span class="pill pill--small pill--info">Mode: ' + esc(m.mode) + "</span>";
    const online = m.online
      ? '<span class="pill pill--small pill--low">Online</span>'
      : '<span class="pill pill--small pill--high">Offline</span>';
    const last = m.last_reading_age_s == null ? "No reading yet" : "Last reading " + fmt.age(m.last_reading_age_s) + " ago";
    return mode + online + "<span>" + esc(last) + "</span>";
  }

  V.overview.body = function body(m) {
    const notices = V.overview.notices
      .map(function (fn) {
        return fn(m);
      })
      .join("");
    return notices + m.compartments.map(row).join("");
  };

  function panel(m) {
    return (
      '<section class="card machine" data-key="m-' + esc(m.id) + '" aria-labelledby="m-' + esc(m.id) + '">' +
      '<div class="machine-head"><h2 class="machine-id" id="m-' + esc(m.id) + '">' + esc(m.id) + "</h2>" +
      '<span class="machine-kind">' + esc(hoppers(m)) + "</span>" +
      '<div class="machine-meta">' + machineMeta(m) + "</div></div>" +
      '<table class="ov-table">' +
      '<colgroup><col style="width:16.4%"><col style="width:20.9%"><col style="width:12.1%">' +
      '<col style="width:22.9%"><col style="width:10%"><col></colgroup>' +
      "<thead><tr><th scope=\"col\">Compartment</th><th scope=\"col\">Stock</th><th scope=\"col\">Urgency</th>" +
      '<th scope="col">Basis</th><th scope="col">Reading age</th><th scope="col">Action</th></tr></thead>' +
      "<tbody>" + V.overview.body(m) + "</tbody></table></section>"
    );
  }

  V.views.overview = {
    load: function () {
      return V.api.getStatus();
    },
    render: function (status) {
      const machines = status.machines || [];
      const first = machines[0] && machines[0].compartments[0];
      if (V.state.selectedId == null && first) V.state.selectedId = first.id;
      return (
        '<div class="page-head"><h1 class="page-title">Overview</h1>' +
        '<p class="page-sub">Refreshes every 2 s. Rows run from High to Low urgency; ties go to the lower stock ' +
        "percentage.</p></div>" +
        (machines.length ? machines.map(panel).join("") : '<div class="card"><p class="empty">No machines.</p></div>')
      );
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
