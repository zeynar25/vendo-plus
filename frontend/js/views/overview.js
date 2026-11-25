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

  function stockCell(c) {
    if (c.value == null) {
      // Sensor problem: no value, only the sensor status in words.
      const word = V.SENSOR_STATUS[c.status] || "No reading yet";
      return '<span class="pill pill--small pill--neutral">' + esc(word) + '</span><span class="ov-pct">No value</span>';
    }
    let html =
      '<span class="ov-value">' + esc(fmt.amount(c.value, c.unit)) + "</span>" +
      '<span class="ov-pct">' + esc(fmt.percent(c.percent)) + " of " + esc(fmt.capacity(c.capacity, c.unit)) +
      "</span>" + V.stockBar(c.percent);
    if (c.status === "over_capacity") html += '<span class="ov-note ov-warn">' + esc(V.SENSOR_STATUS.over_capacity) + "</span>";
    return html;
  }

  function urgencyCell(c) {
    if (c.refill_open) return '<span class="pill pill--info">Refill in progress</span>';
    if (c.acknowledged) {
      return '<span class="pill pill--neutral"><span class="icon" aria-hidden="true">—</span>Acknowledged</span>';
    }
    if (!c.label) return '<span class="ov-none">No urgency</span>';
    return V.urgencyPill(c.label);
  }

  function basisCell(c) {
    if (c.acknowledged) {
      return (
        '<span class="ov-note">' + esc(c.label) +
        " alert hidden from the overview until the urgency changes. Stock is unchanged.</span>"
      );
    }
    if (!c.label) return '<span class="ov-note">' + esc(V.NO_LABEL_REASON[c.reason] || "No urgency.") + "</span>";
    return V.basisTag(c.method) + '<span class="ov-note">' + esc(V.basisText(c.method, c.reason)) + "</span>";
  }

  /** Acknowledge hides a Medium or High alert; it never records a refill or changes the stock. */
  function acknowledgeButton(c) {
    if (c.acknowledged || (c.label !== "Medium" && c.label !== "High")) return "";
    return (
      '<button type="button" class="btn" data-action="acknowledge" data-id="' + esc(c.id) + '" aria-label="Acknowledge the ' +
      esc(c.label) + " alert for the " + esc(c.name) + '">Acknowledge</button>'
    );
  }

  function actionCell(c) {
    const ack = acknowledgeButton(c);
    if (c.unrecorded_refill_id == null) return ack;
    return (
      ack + (ack ? '<span class="ov-gap"></span>' : "") +
      '<span class="ov-prompt">Unrecorded refill detected</span>' +
      '<button type="button" class="btn btn--outline btn--small" data-action="reconcile" data-reset="' +
      esc(c.unrecorded_refill_id) + '">Reconcile refill</button>'
    );
  }

  /** The cells of one compartment row, for every state in the Figma guideline. */
  V.overview.cells = function cells(c) {
    return { stock: stockCell(c), urgency: urgencyCell(c), basis: basisCell(c), age: ageCell(c), action: actionCell(c) };
  };

  V.overview.nameCell = function nameCell(c) {
    return (
      '<a class="ov-name" href="#/compartment/' + esc(c.id) + '">' + esc(c.name) + "</a>" +
      '<span class="ov-code">' + esc(c.code) + "</span>"
    );
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

  /** Full-width rows above the compartments. */
  V.overview.notices = V.overview.notices || [];

  /** Replayed readings always carry this banner; they are never called live or measured. */
  V.replayBanner = function replayBanner(replay) {
    if (!replay) return "";
    return (
      '<div class="replay-banner" role="note">' +
      '<strong class="replay-title">Replayed from sales records, not live</strong>' +
      "<span>These stock values are simulated by replaying sales records. They are not measured and not live.</span>" +
      '<span class="replay-meta"><span>Source time: ' + esc(fmt.fullTime(replay.source_time)) + "</span>" +
      "<span>Speed: " + esc(replay.speed) + "×</span></span></div>"
    );
  };

  V.overview.notices.push(function (m) {
    if (m.mode !== "replay") return "";
    return '<tr class="notice" data-key="replay"><td colspan="6">' + V.replayBanner(m.replay) + "</td></tr>";
  });

  /** One line above the rows while alerts are acknowledged (Figma frame 1b). */
  V.overview.notices.push(function (m) {
    const acked = m.compartments.filter(function (c) {
      return c.acknowledged;
    });
    if (!acked.length) return "";
    let text;
    if (acked.length === 1) {
      text =
        "1 alert acknowledged: the " + acked[0].name + " stays listed with its stock, and its " + acked[0].label +
        " alert is hidden until the urgency changes. No refill was recorded.";
    } else {
      const names = acked.map(function (c) {
        return c.name;
      });
      text =
        acked.length + " alerts acknowledged: the " + names.slice(0, -1).join(", ") + " and " + names[names.length - 1] +
        " stay listed with their stock, and their alerts are hidden until the urgency changes. No refill was recorded.";
    }
    return '<tr class="notice" data-key="acknowledged"><td colspan="6"><div class="ack-notice">' + esc(text) + "</div></td></tr>";
  });

  V.actions = V.actions || {};
  V.actions.acknowledge = function (el) {
    el.disabled = true;
    V.state.actionError = null;
    return V.api.acknowledge(Number(el.getAttribute("data-id"))).catch(V.showActionError);
  };

  V.actions.reconcile = function (el) {
    el.disabled = true;
    V.state.actionError = null;
    return V.api.reconcile(Number(el.getAttribute("data-reset"))).catch(V.showActionError);
  };

  /** Keeps a failed action's message on screen until it is dismissed or another action runs. */
  V.showActionError = function showActionError(err) {
    V.state.actionError = (err && err.detail) || (err && err.message) || "The action failed.";
  };

  V.actions["dismiss-error"] = function () {
    V.state.actionError = null;
  };

  V.actionErrorHtml = function actionErrorHtml() {
    if (!V.state.actionError) return "";
    return (
      '<div class="action-error" role="alert"><span>The last action failed: ' + esc(V.state.actionError) + "</span>" +
      '<button type="button" class="btn btn--small" data-action="dismiss-error">Dismiss</button></div>'
    );
  };

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
    if (!m.online) {
      // Offline: an offline message instead of the stock values.
      const age = m.last_reading_age_s == null ? "" : " The last valid reading is " + fmt.age(m.last_reading_age_s) + " old.";
      return (
        '<tr class="notice" data-key="offline"><td colspan="6"><div class="offline" role="status">' +
        "<strong>" + esc(m.id) + " is offline</strong>" +
        "<span>No valid reading has arrived for 15 s, so its stock values are hidden." + esc(age) +
        " They return when the kit reports again.</span></div></td></tr>"
      );
    }
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
        "percentage.</p></div>" + V.actionErrorHtml() +
        (machines.length ? machines.map(panel).join("") : '<div class="card"><p class="empty">No machines.</p></div>')
      );
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
