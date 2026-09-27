/* analytics.js — lightweight event logging for UX telemetry
 * - stores events to localStorage for resilience
 * - attempts to send via navigator.sendBeacon or fetch in background
 * - provides `track(kind, data)` used across UI to record interactions
 */

const KEY = "drift_analytics_v1";
const BATCH_SIZE = 8;
const FLUSH_INTERVAL = 15000; // ms

function now() {
  return Date.now();
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch (e) {
    return [];
  }
}

function save(arr) {
  try {
    localStorage.setItem(KEY, JSON.stringify(arr));
  } catch (e) {
    /* ignore */
  }
}

function sendBatch(batch) {
  try {
    const payload = JSON.stringify({ ts: now(), events: batch });
    // prefer sendBeacon for background reliability
    if (navigator.sendBeacon) {
      const ok = navigator.sendBeacon(
        "/_log",
        new Blob([payload], { type: "application/json" }),
      );
      if (ok) return Promise.resolve(true);
    }
    // fallback to fetch (fire-and-forget)
    return fetch("/_log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    })
      .then(() => true)
      .catch(() => false);
  } catch (e) {
    return Promise.resolve(false);
  }
}

const analytics = {
  _buf: load(),
  _timer: null,
  _debug: false,

  track(kind, data = {}) {
    try {
      const ev = { kind, data, ts: now(), ua: navigator.userAgent };
      this._buf.push(ev);
      if (this._debug) console.info("[analytics] track", ev);
      save(this._buf);
      if (this._buf.length >= BATCH_SIZE) this.flush();
      if (!this._timer)
        this._timer = setTimeout(() => this.flush(), FLUSH_INTERVAL);
    } catch (e) {
      /* best-effort */
    }
  },

  flush() {
    if (!this._buf.length) return;
    const batch = this._buf.slice(0, BATCH_SIZE);
    // optimistic: remove immediately, re-add on failure
    this._buf = this._buf.slice(batch.length);
    save(this._buf);
    sendBatch(batch)
      .then((ok) => {
        if (!ok) {
          // restore
          this._buf = batch.concat(this._buf);
          save(this._buf);
        }
      })
      .finally(() => {
        if (this._timer) {
          clearTimeout(this._timer);
          this._timer = null;
        }
      });
  },

  // Force send current buffered events immediately. Returns a Promise<boolean>.
  async sendNow() {
    if (!this._buf.length) return true;
    const batch = this._buf.slice(0);
    this._buf = [];
    save(this._buf);
    if (this._debug) console.info("[analytics] sendNow", batch);
    const ok = await sendBatch(batch).catch(() => false);
    if (!ok) {
      // restore on failure
      this._buf = batch.concat(this._buf);
      save(this._buf);
    }
    return ok;
  },

  setDebug(on) {
    this._debug = !!on;
    try {
      localStorage.setItem(KEY + ":debug", this._debug ? "1" : "0");
    } catch (e) {}
    return this._debug;
  },

  dump() {
    return load();
  },
};

// periodically flush while page is open
setInterval(() => analytics.flush(), FLUSH_INTERVAL + 2000);

// restore debug flag from storage if present
try {
  const d = localStorage.getItem(KEY + ":debug");
  if (d === "1") analytics._debug = true;
} catch (e) {}

export { analytics };
