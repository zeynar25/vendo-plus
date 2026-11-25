/*
 * Static sample data for the coffee machine, shaped exactly like the backend's
 * responses in docs/api-contract.md, so the views do not change when the real
 * API takes over. All values are synthetic.
 *
 * Pick a scenario with ?scenario= in the address bar:
 *   live     (default) live mode, model urgencies, fresh readings; refill works
 *   replay   replay mode from sales records (Figma frames 1 and 2)
 *   history  live mode while 24 hours of history builds; readings 12 s old
 *            (Figma frames 1c and 2b)
 *
 * The operator actions (acknowledge, refill, reconcile) change this in-memory
 * data the way the backend would, until the page is reloaded.
 */
(function (root) {
  "use strict";
  const V = (root.Vendo = root.Vendo || {});

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const STALE_AFTER_S = 10;
  const OFFLINE_AFTER_S = 15;
  const STABLE_AFTER_TRIES = 2; // the sample answers "not stable" twice before a refill can start or end
  const VALID = ["ok", "corrected_zero"];
  const LABEL_ORDER = { High: 0, Medium: 1, Low: 2 };

  class ApiError extends Error {
    constructor(status, detail) {
      super(detail);
      this.name = "ApiError";
      this.status = status;
      this.detail = detail;
    }
  }
  V.ApiError = ApiError;

  V.now = V.now || function () {
    return Date.now();
  };

  function iso(ms) {
    return new Date(ms).toISOString();
  }

  /** The basic stock warning: High at or below 5 %, Medium at or below 20 %, Low above. */
  V.basicLabel = function basicLabel(percent) {
    if (percent == null) return null;
    if (percent <= 5) return "High";
    if (percent <= 20) return "Medium";
    return "Low";
  };

  /** Ranks like the backend: High, Medium, Low, then no label; ties by lower stock percentage. */
  V.rankCompartments = function rankCompartments(list) {
    return list.slice().sort(function (a, b) {
      const la = a.label in LABEL_ORDER ? LABEL_ORDER[a.label] : 3;
      const lb = b.label in LABEL_ORDER ? LABEL_ORDER[b.label] : 3;
      if (la !== lb) return la - lb;
      const pa = a.percent == null ? 101 : a.percent;
      const pb = b.percent == null ? 101 : b.percent;
      return pa - pb;
    });
  };

  /** A smooth, repeatable stock line: one point per 5 minutes, ending at `endMs`. */
  function series(endMs, hours, from, to, seed) {
    const points = [];
    const n = Math.round((hours * 60) / 5);
    let s = seed;
    for (let i = 0; i <= n; i++) {
      s = (s * 1664525 + 1013904223) % 4294967296;
      const x = i / n;
      const wobble = Math.sin(x * Math.PI * 5 + seed) * 8 + (s / 4294967296 - 0.5) * 6;
      const value = Math.max(0, from + (to - from) * x + (i === n ? 0 : wobble));
      points.push({ t: iso(endMs - (n - i) * 5 * MIN), value: Math.round(value * 10) / 10 });
    }
    return points;
  }

  function alerts(endMs, list) {
    return list.map(function (a) {
      return { made_at: iso(V.now() - a[0]), t: iso(endMs - a[0]), label: a[1], method: a[2], reason: a[3] || null };
    });
  }

  function build(name) {
    const now = V.now();
    const replay = name === "replay";
    const building = name === "history";
    const end = replay ? Date.parse("2025-01-14T09:30:00+08:00") : now;
    const method = building ? "basic" : "model";
    const reason = building ? "history_short" : null;
    const rates = function (a, b, c) {
      return building ? null : { last_1h: a, last_6h: b, last_24h: c };
    };
    const hist = building ? 5 : 24;

    const compartments = [
      {
        id: 1, code: "coffee", name: "Coffee hopper", unit: "g", capacity: 1000,
        value: building ? 600 : 640, status: "ok", calibration_version: 1,
        label: "Low", method: method, reason: reason,
        rates: rates(22, 19, 18),
        history: series(end, hist, building ? 700 : 905, building ? 600 : 640, 7),
        alerts: alerts(end, [[12 * HOUR, "Low", method, reason]]),
      },
      {
        id: 2, code: "milk", name: "Milk hopper", unit: "g", capacity: 1000,
        value: building ? 40 : 48, status: "ok", calibration_version: 1,
        label: "High", method: method, reason: reason,
        rates: rates(36, 31, 27),
        history: series(end, hist, building ? 200 : 690, building ? 40 : 48, 3),
        alerts: alerts(end, building
          ? [[10 * MIN, "High", method, reason], [72 * MIN, "Medium", method, reason],
             [162 * MIN, "Medium", method, reason], [252 * MIN, "Medium", method, reason],
             [282 * MIN, "Medium", method, reason]]
          : [[2 * MIN, "High", method], [205 * MIN, "Medium", method], [470 * MIN, "Medium", method],
             [975 * MIN, "Low", method], [1240 * MIN, "Medium", method]]),
      },
      {
        id: 3, code: "chocolate", name: "Chocolate hopper", unit: "g", capacity: 1000,
        value: 180, status: "ok", calibration_version: 1,
        label: "Medium", method: method, reason: reason,
        rates: rates(14, 12, 11),
        history: series(end, hist, building ? 300 : 420, 180, 11),
        alerts: alerts(end, [[60 * MIN, "Medium", method, reason], [10 * HOUR, "Low", method, reason]]),
      },
    ];

    return {
      name: name,
      started: now,
      fixedAge: building ? 12 : null,
      machine: { id: "coffee-01", name: "Coffee machine", kind: "coffee", mode: replay ? "replay" : "live" },
      replay: replay
        ? { run_id: 3, source_time: "2025-01-14T09:30:00+08:00", speed: 60, started_at: iso(now - 20 * MIN) }
        : null,
      compartments: compartments,
      ackLabel: {},
      openRefill: {},
      tries: {},
      nextRefillId: 20,
      refills: {
        1: [
          refill(11, "closed", "recorded", now - 6 * DAY - 2 * HOUR, 6 * MIN, 160, 955),
          refill(9, "closed", "recorded", now - 13 * DAY - 5 * HOUR, 7 * MIN, 210, 940),
        ],
        2: [
          refill(12, "closed", "recorded", now - 9 * DAY - 5 * HOUR, 7 * MIN, 120, 960),
          reconciled(10, now - 14 * DAY + 2 * HOUR, 695),
          refill(8, "closed", "recorded", now - 21 * DAY - 3 * HOUR, 6 * MIN, 95, 930),
        ],
        3: [refill(13, "closed", "recorded", now - 4 * DAY - 7 * HOUR, 5 * MIN, 140, 910)],
      },
      unrecorded: { 2: [{ history_reset_id: 7, at: iso(now - 6 * DAY + 9 * HOUR), jump: 412 }] },
    };
  }

  function refill(id, status, kind, start, length, before, after) {
    return {
      id: id, status: status, kind: kind, started_at: iso(start), ended_at: iso(start + length),
      before_value: before, after_value: after, added: Math.max(0, after - before),
    };
  }

  function reconciled(id, at, added) {
    // A reconciled refill has only the size of the detected jump.
    return {
      id: id, status: "closed", kind: "reconciled", started_at: iso(at), ended_at: iso(at),
      before_value: null, after_value: null, added: added,
    };
  }

  function pickScenario() {
    const search = root.location && root.location.search ? root.location.search : "";
    const name = new URLSearchParams(search).get("scenario");
    return ["live", "replay", "history"].indexOf(name) >= 0 ? name : "live";
  }

  let store = null;
  function db() {
    if (!store) store = build(pickScenario());
    return store;
  }

  /** Starts over from a fresh copy of a scenario (used by the tests). */
  V.resetSample = function resetSample(name) {
    store = build(name || pickScenario());
    return store;
  };

  /** Readings arrive every 5 s, so in live and replay the age cycles from about 1 to 5 s. */
  function readingAge() {
    const s = db();
    if (s.fixedAge != null) return s.fixedAge;
    const elapsed = (V.now() - s.started) / 1000;
    return Math.round((((elapsed + 2.6) % 5) + 0.4) * 10) / 10;
  }

  function find(id) {
    const c = db().compartments.find(function (x) {
      return x.id === Number(id);
    });
    if (!c) throw new ApiError(404, "unknown compartment");
    return c;
  }

  function isReplay() {
    return db().machine.mode === "replay";
  }

  function compartmentState(c) {
    const s = db();
    const age = readingAge();
    const valid = VALID.indexOf(c.status) >= 0 && c.value != null;
    const open = !isReplay() && Boolean(s.openRefill[c.id]);
    let label = c.label;
    let method = c.method;
    let reason = c.reason;
    if (!valid) {
      label = null;
      method = null;
      reason = c.status == null ? "no_reading" : "invalid_reading";
    } else if (open) {
      label = null;
      method = null;
      reason = "refill_open";
    }
    const pending = s.unrecorded[c.id] || [];
    return {
      id: c.id, code: c.code, name: c.name, unit: c.unit, capacity: c.capacity,
      value: c.value,
      percent: c.value == null ? null : Math.round((1000 * c.value) / c.capacity) / 10,
      status: c.status,
      calibration_version: c.calibration_version,
      reading_age_s: age,
      stale: age > STALE_AFTER_S,
      label: label, method: method, reason: reason,
      acknowledged: (label === "Medium" || label === "High") && s.ackLabel[c.id] === label,
      refill_open: open,
      unrecorded_refill_id: isReplay() || !pending.length ? null : pending[0].history_reset_id,
    };
  }

  function machineState() {
    const s = db();
    const states = s.compartments.map(compartmentState);
    const validAges = states
      .filter(function (c) {
        return VALID.indexOf(c.status) >= 0 && c.reading_age_s != null;
      })
      .map(function (c) {
        return c.reading_age_s;
      });
    const last = validAges.length ? Math.min.apply(null, validAges) : null;
    return {
      id: s.machine.id, name: s.machine.name, kind: s.machine.kind, mode: s.machine.mode,
      online: last != null && last <= OFFLINE_AFTER_S,
      last_reading_age_s: last,
      replay: s.replay,
      compartments: V.rankCompartments(states),
    };
  }

  function reply(value) {
    const copy = JSON.parse(JSON.stringify(value));
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve(copy);
      }, 60);
    });
  }

  function attempt(fn) {
    try {
      return reply(fn());
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** The backend needs three valid reports within 5 g; the sample makes the caller retry twice. */
  function requireStable(id, step) {
    const s = db();
    const key = id + ":" + step;
    s.tries[key] = (s.tries[key] || 0) + 1;
    if (s.tries[key] <= STABLE_AFTER_TRIES) throw new ApiError(409, "not stable");
    s.tries[key] = 0;
  }

  V.sampleApi = {
    source: "sample",
    scenario: function () {
      return db().name;
    },

    getStatus: function () {
      return attempt(function () {
        return { server_time: iso(V.now()), machines: [machineState()] };
      });
    },

    getCompartment: function (id) {
      return attempt(function () {
        const c = find(id);
        return {
          machine_id: db().machine.id,
          mode: db().machine.mode,
          clock: isReplay() ? "source" : "live",
          compartment: compartmentState(c),
          consumption_per_hour: c.rates,
          history: c.history,
          recent_urgency: c.alerts.slice(0, 20),
        };
      });
    },

    getRefills: function (id) {
      return attempt(function () {
        find(id);
        const s = db();
        const list = (s.refills[id] || []).slice().sort(function (a, b) {
          return Date.parse(b.started_at) - Date.parse(a.started_at);
        });
        return { refills: list, unrecorded_refills: s.unrecorded[id] || [] };
      });
    },

    acknowledge: function (id) {
      return attempt(function () {
        const c = find(id);
        const state = compartmentState(c);
        if (state.label !== "Medium" && state.label !== "High") throw new ApiError(409, "nothing to acknowledge");
        db().ackLabel[c.id] = state.label;
        return { compartment_id: c.id, acknowledged_label: state.label };
      });
    },

    startRefill: function (id) {
      return attempt(function () {
        const s = db();
        const c = find(id);
        if (isReplay()) throw new ApiError(409, "refill mode is not available during replay");
        if (s.openRefill[c.id]) throw new ApiError(409, "a refill is already open");
        requireStable(c.id, "start");
        const r = {
          id: s.nextRefillId++, status: "open", kind: "recorded", started_at: iso(V.now()), ended_at: null,
          before_value: c.value, after_value: null, added: null,
        };
        s.openRefill[c.id] = r;
        (s.refills[c.id] = s.refills[c.id] || []).push(r);
        return { refill_id: r.id, status: "open", before_value: r.before_value };
      });
    },

    endRefill: function (id) {
      return attempt(function () {
        const s = db();
        const c = find(id);
        const r = s.openRefill[c.id];
        if (!r) throw new ApiError(409, "no open refill");
        requireStable(c.id, "end");
        const after = Math.max(r.before_value, Math.round(c.capacity * 0.94));
        r.status = "closed";
        r.ended_at = iso(V.now());
        r.after_value = after;
        r.added = Math.max(0, after - r.before_value);
        delete s.openRefill[c.id];
        // After a refill the history window holds the refill, so the basic warning is used.
        c.value = after;
        c.label = V.basicLabel((100 * after) / c.capacity);
        c.method = "basic";
        c.reason = "refill_in_window";
        c.history = c.history.concat([{ t: iso(V.now()), value: after }]);
        c.alerts = alerts(V.now(), [[0, c.label, "basic", "refill_in_window"]]).concat(c.alerts);
        delete s.ackLabel[c.id];
        return { refill_id: r.id, status: "closed", before_value: r.before_value, after_value: after, added: r.added };
      });
    },

    cancelRefill: function (id) {
      return attempt(function () {
        const s = db();
        const c = find(id);
        const r = s.openRefill[c.id];
        if (!r) throw new ApiError(409, "no open refill");
        r.status = "cancelled";
        r.ended_at = iso(V.now());
        delete s.openRefill[c.id];
        s.tries[c.id + ":end"] = 0;
        return { refill_id: r.id, status: "cancelled", history_reset: false };
      });
    },

    reconcile: function (resetId) {
      return attempt(function () {
        const s = db();
        let found = null;
        Object.keys(s.unrecorded).forEach(function (cid) {
          const list = s.unrecorded[cid];
          const i = list.findIndex(function (u) {
            return u.history_reset_id === Number(resetId);
          });
          if (i >= 0) found = { cid: Number(cid), item: list.splice(i, 1)[0] };
        });
        if (!found) throw new ApiError(404, "unknown history reset");
        const r = reconciled(s.nextRefillId++, Date.parse(found.item.at), found.item.jump);
        (s.refills[found.cid] = s.refills[found.cid] || []).push(r);
        return { history_reset_id: found.item.history_reset_id, refill_id: r.id, added: found.item.jump };
      });
    },
  };

  // Until the API commit, the dashboard reads only the sample data.
  V.api = V.sampleApi;
})(typeof window !== "undefined" ? window : globalThis);
