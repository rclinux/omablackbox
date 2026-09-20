.pragma library

// Everything OmaBlackbox needs to know about talking to journald, kept free of
// QML so it can be tested: the exact argv for every journalctl invocation, and
// the parsers for its output. The QML side only spawns processes and hands the
// text back here.

// Messages the system manager (PID 1) logs only while shutting the machine
// down: it stops its targets in a fixed order and stops the services that
// persist state. A boot whose PID-1 log never contains one ended abruptly
// (power loss, hard reset, freeze, crash). Deliberately NOT matched: "Reached
// target Shutdown" and "shutting down", which the per-user manager and ordinary
// applications also log at plain logout, so they cannot vouch for the system.
// Shared with journalctl --grep, so it stays valid PCRE and JS.
var SHUTDOWN_PATTERN =
  "^(?:stopped target (?:local file systems|system initialization|basic system|multi-user system)|" +
  "stopping (?:flush journal to persistent storage|record system boot/shutdown in utmp|load/save (?:os )?random seed)\\.\\.\\.)"

var FIELDS = "--output-fields=MESSAGE,PRIORITY"

function grepArgs(pattern, useGrep) {
  return useGrep && pattern ? ["-g", pattern, "--case-sensitive=false"] : []
}

// Detect whether journalctl exists / can read the system journal.
function probeArgs() {
  return ["journalctl", "-n", "1", "-o", "cat", "--no-pager", "_TRANSPORT=kernel"]
}

function listBootsArgs() {
  return ["journalctl", "--list-boots", "-o", "json", "--no-pager"]
}

// Live tail of the current boot's kernel messages, from now on.
function followArgs(pattern, useGrep) {
  return ["journalctl", "-f", "-n", "0", "-b", "0", "-o", "json", "--no-pager", FIELDS]
    .concat(grepArgs(pattern, useGrep), ["_TRANSPORT=kernel"])
}

// All matching kernel messages of one boot ("0" = current, or a boot id).
function scanArgs(boot, pattern, useGrep) {
  return ["journalctl", "-b", String(boot), "-o", "json", "--no-pager", FIELDS]
    .concat(grepArgs(pattern, useGrep), ["_TRANSPORT=kernel"])
}

// Did this boot ever log a shutdown sequence?
function shutdownCheckArgs(boot) {
  return ["journalctl", "-b", String(boot), "-o", "cat", "--no-pager", "-n", "1"]
    .concat(grepArgs(SHUTDOWN_PATTERN, true), ["_PID=1"])
}

// A boot id from list-boots is 32 hex characters; never pass anything else to
// journalctl as an argument.
function isBootId(value) {
  return /^[0-9a-f]{32}$/i.test(String(value))
}

// ---- parsers ---------------------------------------------------------------

function messageText(field) {
  if (typeof field === "string") return field
  if (field && typeof field.length === "number" && typeof field !== "string") {
    // journald emits an array of byte values for non-UTF-8 messages.
    var s = ""
    for (var i = 0; i < field.length; i++) s += String.fromCharCode(field[i] & 255)
    return s
  }
  return ""
}

// One JSON object per line -> { ts (usec), cursor, msg, boot, prio } or null.
function parseEvent(line) {
  var text = String(line || "").trim()
  if (text.length === 0 || text.charAt(0) !== "{") return null
  var o
  try { o = JSON.parse(text) } catch (e) { return null }
  var ts = Number(o.__REALTIME_TIMESTAMP)
  if (!isFinite(ts) || ts <= 0) return null
  return {
    ts: ts,
    cursor: typeof o.__CURSOR === "string" ? o.__CURSOR : "",
    msg: messageText(o.MESSAGE),
    boot: typeof o._BOOT_ID === "string" ? o._BOOT_ID : "",
    prio: o.PRIORITY === undefined ? -1 : Number(o.PRIORITY)
  }
}

function parseEvents(text) {
  var out = []
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var e = parseEvent(lines[i])
    if (e) out.push(e)
  }
  return out
}

// journalctl --list-boots -o json -> [{ index, boot, first, last }] (usec).
function parseBootList(text) {
  var arr
  try { arr = JSON.parse(String(text || "")) } catch (e) { return [] }
  if (!arr || typeof arr.length !== "number") return []
  var out = []
  for (var i = 0; i < arr.length; i++) {
    var b = arr[i]
    if (!b || !isBootId(b.boot_id)) continue
    var first = Number(b.first_entry)
    var last = Number(b.last_entry)
    if (!isFinite(first) || !isFinite(last)) continue
    out.push({ index: Number(b.index), boot: String(b.boot_id).toLowerCase(), first: first, last: last })
  }
  return out
}

function currentBoot(list) {
  var best = null
  for (var i = 0; i < list.length; i++) {
    if (best === null || list[i].index > best.index) best = list[i]
  }
  return best
}

// Previous boots worth scanning: within the window, newest first, capped.
function selectBoots(list, nowUs, days, maxBoots) {
  var cur = currentBoot(list)
  var floor = nowUs - Math.max(1, days) * 86400 * 1000000
  var out = []
  for (var i = 0; i < list.length; i++) {
    var b = list[i]
    if (cur && b.boot === cur.boot) continue
    if (b.last < floor) continue
    out.push(b)
  }
  out.sort(function (a, b) { return b.last - a.last })
  return out.slice(0, Math.max(0, maxBoots))
}

// Output of shutdownCheckArgs: any real log line means a shutdown sequence was
// logged. journalctl prints "-- No entries --" (or nothing) when there is none.
function sawShutdown(stdout) {
  var lines = String(stdout || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].trim()
    if (l.length > 0 && l.indexOf("-- ") !== 0) return true
  }
  return false
}

// Decide whether the kernel log is readable, from a probe run.
// -> "ok" | "no-access" | "no-journal"
function classifyProbe(exitCode, stdout, stderr) {
  var all = String(stdout || "") + "\n" + String(stderr || "")
  if (/insufficient permissions|not seeing messages from other users|No journal files were opened/i.test(all)) return "no-access"
  if (/Failed to (?:open|get|determine)|No journal files were found|Journal file .* corrupt/i.test(all)) return "no-journal"
  if (exitCode !== 0 && String(stdout || "").trim() === "") return "no-journal"
  return "ok"
}

// journalctl too old to know --grep / --case-sensitive?
function grepUnsupported(stderr) {
  return /unrecognized option|unknown option|invalid option|Compiled without pattern matching/i.test(String(stderr || ""))
}

// ---- flood protection --------------------------------------------------------
// A dying GPU driver can log millions of lines in minutes (one real boot logged
// over two million). The shell must never spend its time on that, so the live
// path admits a bounded number of lines per second through a token bucket and
// counts the rest, and no scan reads more than MAX_SCAN_EVENTS events.

var FLOOD_BURST = 300
var FLOOD_RATE = 300           // sustained lines per second
var MAX_SCAN_EVENTS = 20000    // per journalctl scan

function newBucket(nowMs) {
  return { tokens: FLOOD_BURST, at: nowMs, dropped: 0 }
}

// true if this line may be processed; false if it must be discarded (and is
// counted in bucket.dropped).
function admit(bucket, nowMs) {
  var elapsed = nowMs - bucket.at
  if (elapsed > 0) {
    bucket.tokens = Math.min(FLOOD_BURST, bucket.tokens + (elapsed / 1000) * FLOOD_RATE)
    bucket.at = nowMs
  }
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return true
  }
  bucket.dropped += 1
  return false
}

// Returns and resets the number of discarded lines.
function takeDropped(bucket) {
  var n = bucket.dropped
  bucket.dropped = 0
  return n
}
