import QtQuick
import Quickshell
import Quickshell.Io
import "lib/Rules.js" as Rules
import "lib/Incidents.js" as Incidents
import "lib/Journal.js" as Journal
import "lib/Format.js" as Fmt
import "lib/Redact.js" as Redact
import "lib/Report.js" as Report
import "lib/Preview.js" as Preview

// OmaBlackbox engine. One instance per shell (the manifest declares a `service`
// kind), shared by every bar widget so a multi-monitor setup never runs two
// journal followers or raises two notifications.
//
// It never writes to the system, needs no privileges, and only ever runs
// `journalctl` (read-only), `notify-send`, `wl-copy` and `mkdir`. Heavy work is
// niced, capped, and flood-guarded so a driver spewing millions of log lines
// cannot slow the desktop down.
Item {
  id: root

  // ---- injected by the host ---------------------------------------------------
  property var shell: null
  property var manifest: null

  // ---- public state (read by the bar widget and the panel) -----------------------
  property string status: "starting"   // starting | watching | no-access | no-journal
  property var rows: []                // incidents at or above minSeverity, newest first
  property int hiddenCount: 0          // lower-severity incidents not listed
  property int unread: 0
  property string worst: ""            // worst unread severity: "" | notice | warning | critical
  property var latestUnread: null
  property int revision: 0
  property bool busy: true             // still reading history
  property int bootsScanned: 0
  property real bootStartMs: 0
  property bool onlyOneBoot: false
  property real nowMs: Date.now()
  property string toast: ""
  property var settings: ({})

  readonly property string version: manifest && manifest.version ? String(manifest.version) : "0.1.0"

  // ---- settings (defaults match the manifest) ----------------------------------------
  function setting(name, fallback) {
    var v = settings ? settings[name] : undefined
    return v === undefined || v === null ? fallback : v
  }
  function clampInt(value, lo, hi, fallback) {
    var n = Math.round(Number(value))
    return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback
  }
  readonly property int scanDays: clampInt(setting("scanDays", 14), 1, 90, 14)
  readonly property int maxBoots: clampInt(setting("maxBoots", 30), 1, 100, 30)
  readonly property string minSeverity: {
    var v = String(setting("minSeverity", "warning"))
    return v === "notice" || v === "warning" || v === "critical" ? v : "warning"
  }
  readonly property string preview: {
    var v = String(setting("preview", "off"))
    return v === "events" || v === "quiet" || v === "no-access" ? v : "off"
  }
  readonly property bool notifyEnabled: setting("notify", true) !== false
  readonly property bool redactEnabled: setting("redact", true) !== false

  readonly property string tooltip: {
    if (status === "no-access") return "OmaBlackbox — can't read the kernel log"
    if (status === "no-journal") return "OmaBlackbox — no system journal found"
    if (status === "starting") return "OmaBlackbox — reading the kernel log"
    if (unread === 0) return rows.length > 0 ? "OmaBlackbox — nothing new" : "OmaBlackbox — all quiet"
    var top = latestUnread
    return "OmaBlackbox — " + unread + " unread" +
      (top ? " · " + top.title + " (" + Fmt.ago(top.lastTs / 1000, nowMs) + ")" : "")
  }

  // ---- internals ------------------------------------------------------------------
  property var store: Incidents.createStore()
  property var bucket: Journal.newBucket(Date.now())
  property bool live: false
  property bool useGrep: true
  property bool stopping: false
  property bool started: false
  property bool stateLoaded: false
  property string previewApplied: "off"
  property real realAcked: 0
  property real ackedThrough: 0
  property var notified: ({})
  property var bootCache: ({})
  property var jobs: []
  property var currentJob: null
  property var failedBoots: ({})
  property string currentBootId: ""
  property int jobEvents: 0
  property bool jobTruncated: false
  property string jobText: ""
  property int followAttempts: 0
  property real followStartedAt: 0
  property bool forceRescan: false
  property bool refreshing: false
  property string kernelRelease: ""
  property string omarchyVersion: ""
  readonly property string prefilter: Rules.prefilter()
  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || (String(Quickshell.env("HOME")) + "/.local/state")) + "/omablackbox"
  readonly property var niceArgs: ["nice", "-n", "19"]

  // ---- lifecycle --------------------------------------------------------------------
  Component.onCompleted: startupDelay.start()
  Component.onDestruction: stop()

  // Let the shell finish its own startup before doing any journal work.
  Timer {
    id: startupDelay
    interval: 1500
    repeat: false
    onTriggered: root.start()
  }

  function start() {
    if (started) return
    started = true
    stopping = false
    if (preview !== "off") {
      enterPreview()
      return
    }
    probeProc.command = Journal.probeArgs()
    probeProc.running = true
  }

  // ---- preview: sample events, no journal, no state, no notifications -------------
  function enterPreview() {
    if (previewApplied === "off") realAcked = ackedThrough
    previewApplied = preview
    started = true
    stop()
    live = false
    store = Incidents.createStore()
    ackedThrough = 0
    var nowUs = Date.now() * 1000
    var data = Preview.build(preview, nowUs)
    for (var i = 0; i < data.events.length; i++) Incidents.ingest(store, data.events[i], Rules.classify)
    for (var j = 0; j < data.ends.length; j++) Incidents.addBootEnd(store, data.ends[j])
    bootStartMs = Date.now() - data.uptimeUs / 1000
    bootsScanned = data.sessions
    onlyOneBoot = false
    busy = false
    status = preview === "no-access" ? "no-access" : "watching"
    publish()
  }

  function leavePreview() {
    previewApplied = "off"
    ackedThrough = realAcked
    store = Incidents.createStore()
    status = "starting"
    busy = true
    rows = []
    unread = 0
    worst = ""
    latestUnread = null
    stopping = false
    live = false
    if (stateLoaded) beginWatching()
    else {
      started = false
      start()
    }
  }

  function stop() {
    stopping = true
    startupDelay.stop()
    followRestart.stop()
    jobs = []
    if (followProc.running) followProc.running = false
    if (jobProc.running) jobProc.running = false
  }

  // ---- 1. can we read the kernel log at all? -------------------------------------
  Process {
    id: probeProc
    stdout: StdioCollector { id: probeOut }
    stderr: StdioCollector { id: probeErr }
    onExited: function(exitCode) {
      var verdict = Journal.classifyProbe(exitCode, probeOut.text, probeErr.text)
      if (verdict !== "ok") {
        root.status = verdict
        root.busy = false
        root.publish()
        return
      }
      mkdirProc.command = ["sh", "-c", 'umask 077; mkdir -p "$1"', "sh", root.stateDir]
      mkdirProc.running = true
    }
  }

  // ---- 2. persistent state: acknowledgements, notified ids, finished-boot cache ----
  Process {
    id: mkdirProc
    onExited: function(exitCode) { stateFile.path = root.stateDir + "/state.json" }
  }

  FileView {
    id: stateFile
    atomicWrites: true
    printErrors: false
    onLoaded: root.applyState(String(stateFile.text()))
    onLoadFailed: function(error) { root.applyState("") }
  }

  function isObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v) }

  function applyState(text) {
    var s = {}
    try { s = JSON.parse(text) } catch (e) { s = {} }
    if (!isObject(s)) s = {}
    stateLoaded = true
    ackedThrough = typeof s.ackedThrough === "number" && isFinite(s.ackedThrough) ? s.ackedThrough : 0
    notified = isObject(s.notified) ? s.notified : {}
    bootCache = isObject(s.boots) ? s.boots : {}
    beginWatching()
  }

  Timer {
    id: saveTimer
    interval: 600
    repeat: false
    onTriggered: root.writeState()
  }

  function saveState() { if (previewApplied === "off") saveTimer.restart() }

  function writeState() {
    if (previewApplied !== "off" || String(stateFile.path) === "") return
    var keep = {}
    var ids = Object.keys(notified)
    if (ids.length > 100) {
      ids.sort(function(a, b) { return notified[a] - notified[b] })
      for (var i = ids.length - 100; i < ids.length; i++) keep[ids[i]] = notified[ids[i]]
    } else {
      keep = notified
    }
    stateFile.setText(JSON.stringify({ v: 1, ackedThrough: ackedThrough, notified: keep, boots: bootCache }))
  }

  // ---- 3. live follower ---------------------------------------------------------------
  function beginWatching() {
    if (stopping) return
    metaProc.running = true
    startFollower()
    listProc.command = Journal.listBootsArgs()
    listProc.running = true
  }

  function startFollower() {
    if (stopping) return
    followProc.command = niceArgs.concat(Journal.followArgs(prefilter, useGrep))
    followStartedAt = Date.now()
    followProc.running = true
  }

  Process {
    id: followProc
    stdout: SplitParser {
      onRead: function(line) { root.onFollowLine(line) }
    }
    stderr: StdioCollector { id: followErr }
    onExited: function(exitCode) {
      if (root.stopping) return
      if (root.useGrep && Journal.grepUnsupported(followErr.text)) {
        // An old journalctl without --grep: filter here instead.
        root.useGrep = false
        root.startFollower()
        return
      }
      // Reset the back-off after a healthy run, otherwise back off (2 s .. 60 s).
      if (Date.now() - root.followStartedAt > 30000) root.followAttempts = 0
      var delays = [2000, 5000, 15000, 60000]
      followRestart.interval = delays[Math.min(root.followAttempts, delays.length - 1)]
      root.followAttempts += 1
      followRestart.start()
    }
  }

  Timer {
    id: followRestart
    repeat: false
    onTriggered: root.startFollower()
  }

  function onFollowLine(line) {
    var now = Date.now()
    if (!Journal.admit(bucket, now)) {
      floodFlush.restart()
      return
    }
    var ev = Journal.parseEvent(line)
    if (!ev) return
    var res = Incidents.ingest(store, ev, Rules.classify)
    var late = Journal.takeDropped(bucket)
    if (late > 0) Incidents.addDropped(store, late)
    if (!res) return
    schedulePublish()
    if (live) maybeNotify(res)
  }

  // After a flood ends, credit the lines that were shed to the incident they belonged to.
  Timer {
    id: floodFlush
    interval: 2000
    repeat: false
    onTriggered: {
      var n = Journal.takeDropped(root.bucket)
      if (n > 0) {
        Incidents.addDropped(root.store, n)
        root.schedulePublish()
      }
    }
  }

  // ---- 4. history: current boot, then earlier boots -------------------------------
  Process {
    id: listProc
    stdout: StdioCollector { id: listOut }
    onExited: function(exitCode) { root.onBootList(String(listOut.text)) }
  }

  function onBootList(text) {
    var list = Journal.parseBootList(text)
    var cur = Journal.currentBoot(list)
    currentBootId = cur ? cur.boot : ""
    bootStartMs = cur ? cur.first / 1000 : Date.now()
    onlyOneBoot = list.length <= 1

    var picked = Journal.selectBoots(list, Date.now() * 1000, scanDays, maxBoots)
    bootsScanned = picked.length + 1

    var queue = [{ k: "scan", boot: "0", cur: true }]
    var keepCache = {}
    for (var i = 0; i < picked.length; i++) {
      var b = picked[i]
      if (!Journal.isBootId(b.boot)) continue
      var entry = forceRescan ? null : bootCache[b.boot]
      if (entry && entry.last === b.last && Array.isArray(entry.incidents)) {
        Incidents.importIncidents(store, entry.incidents)
        keepCache[b.boot] = entry
      } else {
        queue.push({ k: "scan", boot: b.boot, meta: b })
        queue.push({ k: "check", boot: b.boot, meta: b })
      }
    }
    // Forget cached boots that have left the scan window.
    for (var id in bootCache) if (keepCache[id] === undefined && !forceRescan) delete bootCache[id]
    forceRescan = false
    jobs = queue
    nextJob()
  }

  Process {
    id: jobProc
    stdout: SplitParser {
      onRead: function(line) { root.onJobLine(line) }
    }
    stderr: StdioCollector { id: jobErr }
    onExited: function(exitCode) { root.onJobExit(exitCode) }
  }

  function nextJob() {
    if (stopping) return
    if (jobs.length === 0) {
      finishBackfill()
      return
    }
    currentJob = jobs.shift()
    jobEvents = 0
    jobTruncated = false
    jobText = ""
    var argv = currentJob.k === "scan"
      ? Journal.scanArgs(currentJob.boot, prefilter, useGrep)
      : Journal.shutdownCheckArgs(currentJob.boot)
    jobProc.command = niceArgs.concat(argv)
    jobProc.running = true
  }

  function onJobLine(line) {
    var j = currentJob
    if (!j) return
    if (j.k === "check") {
      if (jobText.length < 4000) jobText += line + "\n"
      return
    }
    if (jobTruncated) return
    jobEvents += 1
    var ev = Journal.parseEvent(line)
    if (ev) Incidents.ingest(store, ev, Rules.classify)
    if (jobEvents >= Journal.MAX_SCAN_EVENTS) {
      jobTruncated = true
      jobProc.running = false
    }
  }

  function onJobExit(exitCode) {
    var j = currentJob
    if (!j || stopping) return
    if (j.k === "scan") {
      if (!jobTruncated && exitCode !== 0 && exitCode !== 1) {
        if (useGrep && Journal.grepUnsupported(jobErr.text)) {
          useGrep = false
          jobs.unshift(j)
          nextJob()
          return
        }
        failedBoots[j.boot] = true
      }
      if (jobTruncated) Incidents.markTruncated(store, j.cur ? currentBootId : j.boot)
    } else if (j.k === "check" && !failedBoots[j.boot]) {
      if (!Journal.sawShutdown(jobText)) {
        Incidents.addBootEnd(store, { boot: j.boot, firstTs: j.meta.first, lastTs: j.meta.last })
      }
      bootCache[j.boot] = { last: j.meta.last, incidents: JSON.parse(JSON.stringify(Incidents.exportBoot(store, j.boot))) }
    }
    schedulePublish()
    nextJob()
  }

  function finishBackfill() {
    live = true
    busy = false
    status = "watching"
    if (refreshing) {
      refreshing = false
      say("Rescan complete")
    }
    publish()
    notifyStartup()
    saveState()
  }

  // ---- 5. publishing to the UI ------------------------------------------------------
  Timer {
    id: publishTimer
    interval: 250
    repeat: false
    onTriggered: root.publish()
  }

  function schedulePublish() { publishTimer.restart() }

  function publish() {
    var all = Incidents.rows(store, { ackedThrough: ackedThrough, minSeverity: minSeverity })
    var floor = Incidents.rank(minSeverity)
    var shown = []
    for (var i = 0; i < all.length; i++) if (Incidents.rank(all[i].sev) >= floor) shown.push(all[i])
    var sum = Incidents.summary(shown)
    var latest = null
    for (var j = 0; j < shown.length; j++) {
      if (shown[j].unread) { latest = shown[j]; break }
    }
    hiddenCount = all.length - shown.length
    rows = shown
    unread = sum.unread
    worst = sum.worst
    latestUnread = latest
    nowMs = Date.now()
    revision += 1
  }

  onMinSeverityChanged: schedulePublish()

  Timer {
    id: clockTick
    interval: 30000
    repeat: true
    running: true
    onTriggered: root.nowMs = Date.now()
  }

  // ---- user actions ---------------------------------------------------------------
  function acknowledgeAll() {
    ackedThrough = Date.now() * 1000
    publish()
    saveState()
    say("Marked all read")
  }

  function refresh() {
    if (!started || busy || previewApplied !== "off") return
    busy = true
    refreshing = true
    say("Rescanning the journal…")
    forceRescan = true
    store = Incidents.createStore()
    failedBoots = ({})
    listProc.running = true
  }

  // ---- notifications ----------------------------------------------------------------
  function markNotified(id) {
    notified[id] = Date.now()
    saveState()
  }

  function sendNotification(title, body) {
    Quickshell.execDetached(["notify-send", "-a", "OmaBlackbox", "-u", "critical", "-i", "dialog-warning", title, body])
  }

  // A live incident that is (or becomes) critical is announced once.
  function maybeNotify(res) {
    if (!notifyEnabled || !res || (!res.created && !res.escalated)) return
    var inc = res.incident
    if (Incidents.rank(inc.sev) < 3 || notified[inc.id]) return
    markNotified(inc.id)
    sendNotification(inc.title, inc.meaning ? inc.meaning.split(". ")[0] + "." : "Open OmaBlackbox for details.")
  }

  // After a crash the desktop is gone, so the moment to say so is the next login.
  // Only for a recent crash: announcing last week's at first install is noise.
  function notifyStartup() {
    if (!notifyEnabled) return
    var cutoff = (Date.now() - 24 * 3600 * 1000) * 1000
    var best = null
    for (var i = 0; i < store.incidents.length; i++) {
      var r = store.incidents[i]
      if (r.kind !== "boot" || r.lastTs <= ackedThrough || r.lastTs < cutoff || notified[r.id]) continue
      if (!best || r.lastTs > best.lastTs) best = r
    }
    if (!best) return
    markNotified(best.id)
    sendNotification("Last session ended without a clean shutdown",
      best.relatedTitle ? "The last critical event was: " + best.relatedTitle + "." : "Open OmaBlackbox for details.")
  }

  // ---- reports ------------------------------------------------------------------------
  Process {
    id: metaProc
    command: ["sh", "-c", "uname -r; omarchy version 2>/dev/null | head -n 1"]
    stdout: StdioCollector { id: metaOut }
    onExited: function(exitCode) {
      var lines = String(metaOut.text).split("\n")
      root.kernelRelease = lines.length > 0 ? lines[0].trim() : ""
      root.omarchyVersion = lines.length > 1 ? lines[1].trim() : ""
    }
  }

  FileView {
    id: reportFile
    blockWrites: true
    atomicWrites: true
    printErrors: false
  }

  Process { id: copyProc }

  function reportText() {
    return Report.buildReport({
      meta: {
        version: version, kernel: kernelRelease, omarchy: omarchyVersion,
        generatedMs: Date.now(), scanDays: scanDays, boots: bootsScanned
      },
      rows: rows,
      redact: redactEnabled,
      deps: { redact: Redact.redact, fmt: Fmt }
    })
  }

  function say(text) {
    toast = text
    toastTimer.restart()
  }

  Timer {
    id: toastTimer
    interval: 6000
    repeat: false
    onTriggered: root.toast = ""
  }

  function stamp() {
    var d = new Date()
    function p(n) { return (n < 10 ? "0" : "") + n }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  }

  function saveReport(thenCopy) {
    if (String(stateFile.path) === "") { say("Not ready yet"); return }
    if (previewApplied !== "off") { say("Preview mode: nothing was copied or saved"); return }
    var name = thenCopy ? "last-report.md" : "report-" + stamp() + ".md"
    var path = stateDir + "/" + name
    reportFile.path = path
    reportFile.setText(reportText())
    if (thenCopy) {
      copyProc.command = ["sh", "-c", 'wl-copy < "$1"', "sh", path]
      copyProc.running = true
      say(redactEnabled ? "Report copied (identifiers masked)" : "Report copied")
    } else {
      say("Saved to " + path)
    }
  }

  function copyReport() { saveReport(true) }
  function saveReportFile() { saveReport(false) }

  // ---- command line: omarchy-shell omablackbox <status|acknowledge|refresh|copy|save> --------------
  IpcHandler {
    target: "omablackbox"

    function status(): string {
      return JSON.stringify({
        version: root.version, status: root.status, busy: root.busy, live: root.live,
        follower: followProc.running, incidents: root.rows.length, unread: root.unread,
        worst: root.worst, hiddenMinor: root.hiddenCount, sessions: root.bootsScanned,
        scanDays: root.scanDays, minSeverity: root.minSeverity, cachedSessions: Object.keys(root.bootCache).length
      })
    }
    function acknowledge(): void { root.acknowledgeAll() }
    function refresh(): void { root.refresh() }
    function copy(): void { root.copyReport() }
    function save(): string { root.saveReportFile(); return root.toast }
  }

  // ---- settings pushed by the bar widget -----------------------------------------------
  property string appliedScanKey: ""

  function applySettings(next) {
    settings = next || ({})
    var key = scanDays + ":" + maxBoots
    if (started && preview !== previewApplied) {
      if (preview === "off") leavePreview()
      else enterPreview()
    } else if (started && previewApplied === "off" && appliedScanKey !== "" && appliedScanKey !== key) {
      refresh()
    }
    appliedScanKey = key
  }
}
