.pragma library

// Groups classified kernel-log lines into incidents.
//
// A real fault is rarely one line: a GPU falling off the bus produces a
// sanity-check failure, an Xid and a recovery notice, often repeated. The user
// should see one event, not a dozen. This module folds related lines into a
// single incident with a start time, the worst severity seen, the most
// specific title, an ordered sequence of steps, and a bounded sample of the raw
// lines.
//
// Pure JavaScript, no QML dependency, so it can be unit tested under Node.

var GAP_US = 60 * 1000000        // lines this close together belong to one incident
var CORRELATE_US = 180 * 1000000 // "the last thing before the log ended" window
var MAX_LINES = 40               // raw lines kept per incident (first HEAD_LINES + newest)
var HEAD_LINES = 30
var MAX_PARTS = 10
var MAX_INCIDENTS = 400
var SEEN_MAX = 8000

var RANK = { notice: 1, warning: 2, critical: 3 }

function rank(sev) { return RANK[sev] || 0 }
function maxSev(a, b) { return rank(a) >= rank(b) ? a : b }

var BOOT_END_MEANING =
  "The log stops without the normal shutdown steps. That happens after a power loss, a hard reset, " +
  "a freeze or a crash, and the log alone cannot say which. Any events listed just before it are the best clues."

function createStore() {
  return {
    seen: {}, seenQueue: [],
    incidents: [],
    open: {},   // boot|key -> latest incident with that key
    last: null  // most recently touched incident (receives flood-dropped counts)
  }
}

function markSeen(store, cursor) {
  store.seen[cursor] = 1
  store.seenQueue.push(cursor)
  if (store.seenQueue.length > SEEN_MAX) {
    var drop = store.seenQueue.splice(0, store.seenQueue.length - SEEN_MAX)
    for (var i = 0; i < drop.length; i++) delete store.seen[drop[i]]
  }
}

function addLine(inc, ts, msg) {
  inc.count += 1
  var entry = { ts: ts, msg: msg }
  if (inc.lines.length < MAX_LINES) {
    inc.lines.push(entry)
  } else {
    // Keep the opening lines and the newest ones; drop from the middle.
    inc.lines.splice(HEAD_LINES, 1)
    inc.lines.push(entry)
  }
}

// One entry per distinct step, in order of first appearance.
function addPart(inc, c, ts) {
  if (!c.title) return
  for (var i = 0; i < inc.parts.length; i++) {
    if (inc.parts[i].title === c.title) { inc.parts[i].n += 1; return }
  }
  if (inc.parts.length < MAX_PARTS) inc.parts.push({ ts: ts, title: c.title, detail: c.detail, sev: c.sev, n: 1 })
}

function addDevice(inc, device) {
  if (!device) return
  if (inc.devices.indexOf(device) === -1 && inc.devices.length < 6) inc.devices.push(device)
}

function newIncident(c, ts, boot) {
  return {
    id: boot + ":" + c.key + ":" + ts,
    boot: boot, cls: c.cls, key: c.key, kind: "fault",
    sev: c.sev, prio: -1, title: "", meaning: "", detail: "", device: "",
    devices: [], parts: [], firstTs: ts, lastTs: ts, count: 0, lines: [],
    related: "", relatedTitle: "", truncated: false
  }
}

function prune(store) {
  if (store.incidents.length <= MAX_INCIDENTS + 50) return
  store.incidents.sort(function (a, b) { return b.lastTs - a.lastTs })
  var dropped = store.incidents.splice(MAX_INCIDENTS)
  var gone = {}
  for (var i = 0; i < dropped.length; i++) gone[dropped[i].id] = true
  for (var k in store.open) if (gone[store.open[k].id]) delete store.open[k]
  if (store.last && gone[store.last.id]) store.last = null
}

// ev: { ts: microseconds since epoch, cursor: string, msg: string, boot: string }
// classify: function(msg) -> classification | null   (Rules.classify)
// Returns null when the line changed nothing, otherwise
// { incident, created, escalated }.
function ingest(store, ev, classify) {
  if (!ev || typeof ev.msg !== "string") return null
  if (ev.cursor) {
    if (store.seen[ev.cursor]) return null
    markSeen(store, ev.cursor)
  }
  var c = classify(ev.msg)
  if (!c) return null

  var ts = Number(ev.ts) || 0
  var boot = String(ev.boot || "")
  var okey = boot + "|" + c.key
  var inc = store.open[okey]
  if (inc && (ts > inc.lastTs + GAP_US || ts < inc.firstTs - GAP_US)) inc = null

  var created = false
  if (!inc) {
    inc = newIncident(c, ts, boot)
    store.incidents.push(inc)
    store.open[okey] = inc
    created = true
  }
  store.last = inc

  var before = inc.sev
  addLine(inc, ts, ev.msg)
  if (ts > inc.lastTs) inc.lastTs = ts
  if (ts < inc.firstTs) inc.firstTs = ts

  inc.sev = created ? c.sev : maxSev(inc.sev, c.sev)
  if (c.prio > inc.prio) {
    inc.prio = c.prio
    inc.title = c.title
    inc.meaning = c.meaning
    inc.detail = c.detail
    if (c.device) inc.device = c.device
  }
  addPart(inc, c, ts)
  addDevice(inc, c.device)

  if (created) prune(store)
  return { incident: inc, created: created, escalated: !created && rank(inc.sev) > rank(before) }
}

// Lines that were discarded unread by the flood guard still happened; credit
// them to the incident they belonged to so the count stays honest.
function addDropped(store, n) {
  if (store.last && n > 0) store.last.count += n
}

// A scan stopped at its event cap: incidents from that boot only reflect the
// start of what was logged, so their counts and end times are lower bounds.
function markTruncated(store, boot) {
  for (var i = 0; i < store.incidents.length; i++) {
    if (store.incidents[i].boot === boot && store.incidents[i].kind === "fault") store.incidents[i].truncated = true
  }
}

// Records that a previous boot's log stopped without a shutdown sequence.
// info: { boot, firstTs, lastTs } (microseconds). Idempotent per boot.
function addBootEnd(store, info) {
  var id = info.boot + ":bootend"
  for (var i = 0; i < store.incidents.length; i++) {
    if (store.incidents[i].id === id) return store.incidents[i]
  }
  var related = null
  for (var j = 0; j < store.incidents.length; j++) {
    var f = store.incidents[j]
    if (f.boot !== info.boot || f.kind !== "fault") continue
    if (rank(f.sev) < 3) continue
    if (f.lastTs < info.lastTs - CORRELATE_US) continue
    if (!related || f.prio > related.prio) related = f
  }
  var gap = related ? Math.max(0, Math.round((info.lastTs - related.lastTs) / 1000000)) : 0
  var detail = ""
  if (related) {
    // A truncated scan only saw the start of a burst, so a "seconds before" claim would be false.
    detail = related.truncated
      ? "Last critical event: " + related.title + " (a very large burst of log lines)"
      : "Last critical event: " + related.title + ", " + gap + " s before the log ended"
  }
  var inc = {
    id: id, boot: info.boot, cls: "boot", key: "boot|end", kind: "boot",
    sev: related ? "critical" : "warning", prio: 0,
    title: "Session ended without a clean shutdown",
    meaning: BOOT_END_MEANING,
    detail: detail,
    device: "", devices: [], parts: [],
    firstTs: info.firstTs || info.lastTs, lastTs: info.lastTs, count: 0, lines: [],
    related: related ? related.id : "", relatedTitle: related ? related.title : "", truncated: false
  }
  store.incidents.push(inc)
  return inc
}

// ---- persistence of finished boots ------------------------------------------
// A finished boot's log never changes, so its incidents are cached and not
// rescanned. These helpers produce and accept plain JSON-safe data.

function exportBoot(store, boot) {
  var out = []
  for (var i = 0; i < store.incidents.length; i++) {
    if (store.incidents[i].boot === boot) out.push(store.incidents[i])
  }
  return out
}

var REQUIRED = ["id", "boot", "kind", "cls", "sev", "title", "firstTs", "lastTs"]

function validIncident(o) {
  if (!o || typeof o !== "object") return false
  for (var i = 0; i < REQUIRED.length; i++) if (o[REQUIRED[i]] === undefined || o[REQUIRED[i]] === null) return false
  if (!RANK[o.sev]) return false
  return typeof o.firstTs === "number" && typeof o.lastTs === "number"
}

// Adds cached incidents to a store, skipping malformed or duplicate ones.
// Returns how many were added.
function importIncidents(store, list) {
  var have = {}
  for (var i = 0; i < store.incidents.length; i++) have[store.incidents[i].id] = true
  var added = 0
  for (var j = 0; j < (list ? list.length : 0); j++) {
    var o = list[j]
    if (!validIncident(o) || have[o.id]) continue
    store.incidents.push({
      id: String(o.id), boot: String(o.boot), kind: String(o.kind), cls: String(o.cls), key: String(o.key || ""),
      sev: o.sev, prio: Number(o.prio) || 0, title: String(o.title), meaning: String(o.meaning || ""),
      detail: String(o.detail || ""), device: String(o.device || ""),
      devices: Array.isArray(o.devices) ? o.devices.slice(0, 6).map(String) : [],
      parts: Array.isArray(o.parts) ? o.parts.slice(0, MAX_PARTS) : [],
      firstTs: o.firstTs, lastTs: o.lastTs, count: Number(o.count) || 0,
      lines: Array.isArray(o.lines) ? o.lines.slice(0, MAX_LINES) : [],
      related: String(o.related || ""), relatedTitle: String(o.relatedTitle || ""), truncated: o.truncated === true
    })
    have[o.id] = true
    added += 1
  }
  return added
}

// Snapshot for the UI: newest first, with an `unread` flag per incident.
// opts: { ackedThrough: microseconds, minSeverity: "notice"|"warning"|"critical" }
//
// A boot that ended abruptly right after a critical fault is one story, not
// two: the fault's row carries the shutdown as a note (`endNote`) and the
// separate "session ended" row is left out. An abrupt end with no fault to
// blame stays a row of its own.
function rows(store, opts) {
  var acked = Number(opts && opts.ackedThrough) || 0
  var minRank = rank((opts && opts.minSeverity) || "warning")
  var byId = {}
  var endOf = {}
  var i
  for (i = 0; i < store.incidents.length; i++) byId[store.incidents[i].id] = store.incidents[i]
  for (i = 0; i < store.incidents.length; i++) {
    var e = store.incidents[i]
    if (e.kind === "boot" && e.related && byId[e.related]) endOf[e.related] = e
  }
  var out = []
  for (i = 0; i < store.incidents.length; i++) {
    var s = store.incidents[i]
    if (s.kind === "boot" && s.related && byId[s.related]) continue
    var end = endOf[s.id]
    var endNote = ""
    if (end) {
      endNote = s.truncated
        ? "Then the session ended without a clean shutdown, during a very large burst of log lines."
        : "Then the session ended without a clean shutdown, " + Math.max(0, Math.round((end.lastTs - s.lastTs) / 1000000)) + " s later."
    }
    var last = end ? Math.max(s.lastTs, end.lastTs) : s.lastTs
    out.push({
      id: s.id, boot: s.boot, kind: s.kind, cls: s.cls, sev: end ? maxSev(s.sev, end.sev) : s.sev,
      title: s.title, meaning: s.meaning, detail: s.detail, device: s.device,
      devices: s.devices, parts: s.parts, firstTs: s.firstTs, lastTs: s.lastTs,
      count: s.count, lines: s.lines, dropped: Math.max(0, s.count - s.lines.length),
      related: s.related, relatedTitle: s.relatedTitle, truncated: s.truncated === true,
      endNote: endNote, endedTs: end ? end.lastTs : 0,
      unread: last > acked && rank(end ? maxSev(s.sev, end.sev) : s.sev) >= minRank
    })
  }
  out.sort(function (a, b) { return b.lastTs - a.lastTs })
  return out
}

function summary(list) {
  var unread = 0
  var worst = ""
  for (var i = 0; i < list.length; i++) {
    if (!list[i].unread) continue
    unread += 1
    worst = worst ? maxSev(worst, list[i].sev) : list[i].sev
  }
  return { unread: unread, worst: worst, total: list.length }
}
