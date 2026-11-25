/*
 * Compartment detail (GET /api/v1/compartments/{id}): the slower decision before
 * a refill. Stock over the last 24 hours, the recent consumption rate, the
 * calibration version, the acknowledge control, and the recent alerts.
 */
(function (root) {
  "use strict";
  const V = (root.Vendo = root.Vendo || {});
  V.views = V.views || {};
  const esc = V.esc;
  const fmt = V.fmt;
  const HOUR = 3600 * 1000;

  /**
   * Loads the status and, when the address names a hopper, that hopper's data.
   * Without a hopper id (or with one that does not exist) it returns
   * { status, entry: null } and the page shows the hopper chooser instead.
   */
  V.loadWithCompartment = function loadWithCompartment(route, loadOne) {
    return V.api.getStatus().then(function (status) {
      const entry = route.id == null ? null : V.hopperList(status).find(function (x) {
        return x.compartment.id === route.id;
      });
      if (!entry) return { status: status, entry: null, missingId: route.id };
      V.state.selectedId = entry.compartment.id;
      return loadOne(entry.compartment.id).then(function (one) {
        return { status: status, entry: entry, one: one };
      });
    });
  };

  // ---- Chart -------------------------------------------------------------
  const W = 760;
  const H = 250;
  const PAD = { left: 52, right: 16, top: 16, bottom: 34 };

  /** Stock over the last 24 hours, with the basic warning thresholds as dashed lines. */
  V.stockChart = function stockChart(history, capacity, unit) {
    const points = (history || []).filter(function (p) {
      return p.value != null;
    });
    if (!points.length) return '<p class="empty">No valid readings in the last 24 hours.</p>';
    const end = Date.parse(points[points.length - 1].t);
    const start = end - 24 * HOUR;
    const x = function (t) {
      return PAD.left + ((t - start) / (24 * HOUR)) * (W - PAD.left - PAD.right);
    };
    const y = function (v) {
      const clamped = Math.max(0, Math.min(capacity, v));
      return PAD.top + (1 - clamped / capacity) * (H - PAD.top - PAD.bottom);
    };
    let svg = "";
    [0, 0.5, 1].forEach(function (f) {
      const yy = y(capacity * f);
      svg += '<line class="grid" x1="' + PAD.left + '" x2="' + (W - PAD.right) + '" y1="' + yy + '" y2="' + yy + '"/>';
      svg += '<text class="axis" x="' + (PAD.left - 8) + '" y="' + (yy + 4) + '" text-anchor="end">' +
        esc(fmt.amount(capacity * f, unit)) + "</text>";
    });
    [24, 18, 12, 6, 0].forEach(function (h) {
      const xx = x(end - h * HOUR);
      svg += '<text class="axis" x="' + xx + '" y="' + (H - 10) + '" text-anchor="middle">' +
        (h ? "−" + h + " h" : "now") + "</text>";
    });
    const med = 0.2 * capacity;
    const high = 0.05 * capacity;
    svg += '<line class="threshold threshold--medium" x1="' + PAD.left + '" x2="' + (W - PAD.right) + '" y1="' + y(med) +
      '" y2="' + y(med) + '"/>';
    svg += '<line class="threshold threshold--high" x1="' + PAD.left + '" x2="' + (W - PAD.right) + '" y1="' + y(high) +
      '" y2="' + y(high) + '"/>';
    const path = points
      .filter(function (p) {
        return Date.parse(p.t) >= start;
      })
      .map(function (p, i) {
        return (i ? "L" : "M") + x(Date.parse(p.t)).toFixed(1) + " " + y(p.value).toFixed(1);
      })
      .join(" ");
    svg += '<path class="stock-line" d="' + path + '"/>';
    const lastPoint = points[points.length - 1];
    svg += '<circle class="stock-dot" cx="' + x(Date.parse(lastPoint.t)).toFixed(1) + '" cy="' + y(lastPoint.value).toFixed(1) +
      '" r="3.5"/>';
    const first = Date.parse(points[0].t);
    if (first - start > 30 * 60 * 1000) {
      const minutes = Math.max(1, Math.round((end - first) / 60000));
      const since = minutes < 60 ? minutes + " min" : Math.round(minutes / 60) + " h";
      // Keep the note inside the chart when history began near either edge.
      const fx = x(first);
      const anchor = fx > W - 120 ? "end" : fx < PAD.left + 80 ? "start" : "middle";
      const fy = Math.max(PAD.top + 12, y(points[0].value) - 10);
      const tx = anchor === "end" ? fx - 10 : anchor === "start" ? fx + 10 : fx;
      svg += '<text class="axis note" x="' + tx + '" y="' + fy + '" text-anchor="' + anchor + '">' +
        "History began " + since + " ago</text>";
    }
    const last = points[points.length - 1].value;
    const label =
      "Stock over the last 24 hours, from " + fmt.amount(points[0].value, unit) + " to " + fmt.amount(last, unit) +
      ". Dashed lines mark the basic warning thresholds at " + fmt.amount(med, unit) + " and " + fmt.amount(high, unit) + ".";
    return (
      '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(label) + '">' + svg + "</svg>" +
      '<ul class="legend">' +
      '<li><span class="key key--stock"></span>Stock (' + esc(unit) + ")</li>" +
      '<li><span class="key key--medium"></span>' + esc(fmt.amount(med, unit)) + " = 20 %: basic Medium threshold</li>" +
      '<li><span class="key key--high"></span>' + esc(fmt.amount(high, unit)) + " = 5 %: basic High threshold</li>" +
      "</ul>"
    );
  };

  // ---- Cards ---------------------------------------------------------------
  function urgencySummary(c) {
    if (c.refill_open) return '<span class="pill pill--info">Refill in progress</span>';
    if (c.acknowledged) return '<span class="pill pill--neutral"><span class="icon" aria-hidden="true">—</span>Acknowledged</span>';
    if (!c.label) return '<span class="pill pill--neutral">No urgency</span>';
    return V.urgencyPill(c.label) + V.basisTag(c.method);
  }

  function meta(c) {
    const parts = [];
    if (c.value == null) parts.push(V.SENSOR_STATUS[c.status] || "No reading yet");
    else parts.push(fmt.amount(c.value, c.unit), fmt.percent(c.percent) + " of " + fmt.capacity(c.capacity, c.unit));
    parts.push("reading age " + fmt.age(c.reading_age_s) + (c.stale ? " · stale" : ""));
    return parts.join(" · ");
  }

  function ratesCard(rates, unit) {
    const r = rates || {};
    const row = function (name, value) {
      return '<div class="rate"><span>' + name + "</span><strong>" + esc(fmt.rate(value, unit)) + "</strong></div>";
    };
    return (
      '<section class="card side-card"><h2 class="card-title">Recent consumption rate</h2>' +
      row("Last 1 h", r.last_1h) + row("Last 6 h", r.last_6h) + row("Last 24 h", r.last_24h) +
      '<p class="fine">The rate exists only when the model runs. Hoppers show — ' + esc(unit) +
      "/h during their first 24 hours of history.</p></section>"
    );
  }

  function calibrationCard(c) {
    return (
      '<section class="card side-card"><h2 class="card-title">Calibration</h2>' +
      '<p class="big">' + (c.calibration_version == null ? "—" : "Version " + esc(c.calibration_version)) + "</p></section>"
    );
  }

  function acknowledgeCard(c) {
    let body;
    if (c.acknowledged) {
      body = '<p class="fine">This ' + esc(c.label) + " alert is acknowledged. It shows again when the urgency changes.</p>";
    } else if (c.label === "Medium" || c.label === "High") {
      body =
        '<p class="fine">Hides the alert from the overview until the urgency changes. It does not record a refill and ' +
        "never changes the stock.</p>" +
        '<button type="button" class="btn" data-action="acknowledge" data-id="' + esc(c.id) + '">Acknowledge</button>';
    } else {
      body = '<p class="fine">Nothing to acknowledge. Only Medium and High alerts can be acknowledged.</p>';
    }
    return '<section class="card side-card"><h2 class="card-title">Acknowledge this alert</h2>' + body + "</section>";
  }

  function alertsCard(list) {
    const rows = (list || [])
      .map(function (a, i) {
        const reason = a.method === "basic" ? (V.BASIC_REASON[a.reason] || "").replace(/\.$/, "") : "—";
        return (
          '<tr data-key="a-' + i + '"><td>' + esc(fmt.dayTime(a.t)) + "</td><td>" + V.urgencyPill(a.label) + "</td><td>" +
          V.basisTag(a.method) + "</td><td>" + esc(reason || "—") + "</td></tr>"
        );
      })
      .join("");
    return (
      '<section class="card alerts-card"><h2 class="card-title">Recent alerts (last 20, newest first)</h2>' +
      (rows
        ? '<table class="plain-table"><thead><tr><th scope="col">Time</th><th scope="col">Urgency</th>' +
          '<th scope="col">Basis</th><th scope="col">Reason</th></tr></thead><tbody>' + rows + "</tbody></table>"
        : '<p class="empty">No alerts yet.</p>') +
      "</section>"
    );
  }

  V.views.compartment = {
    load: function (route) {
      return V.loadWithCompartment(route, V.api.getCompartment);
    },
    render: function (data) {
      if (!data.entry) return V.hopperChooser(data.status, "compartment", data.missingId);
      const m = data.entry.machine;
      const d = data.one;
      const c = d.compartment;
      return (
        '<div class="page-head detail-head"><p class="crumb">' + esc(d.machine_id) + " / " + esc(c.code) + "</p>" +
        '<div class="title-row"><h1 class="page-title">' + esc(c.name) + "</h1>" + urgencySummary(c) +
        '<span class="meta">' + esc(meta(c)) + "</span>" + V.hopperSwitch(data.status, "compartment", c.id) + "</div></div>" +
        V.actionErrorHtml() +
        (d.mode === "replay" ? V.replayBanner(m.replay) : "") +
        '<div class="detail-grid">' +
        '<section class="card chart-card"><h2 class="card-title">Stock over the last 24 hours (history, one point per 5 ' +
        "minutes)</h2>" + V.stockChart(d.history, c.capacity, c.unit) + "</section>" +
        '<div class="side">' + ratesCard(d.consumption_per_hour, c.unit) + calibrationCard(c) + acknowledgeCard(c) + "</div>" +
        "</div>" + alertsCard(d.recent_urgency)
      );
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
