.pragma library

// Builds the shareable text report. Everything that leaves the machine goes
// through the injected `redact` function, and the report says so. Pure
// JavaScript so it can be unit tested under Node.
//
// ctx: {
//   meta:  { version, kernel, omarchy, generatedMs, scanDays, boots },
//   rows:  incidents as returned by Incidents.rows(),
//   redact: bool,
//   deps:  { redact: function(text) -> { text, total, counts }, fmt: Format module }
// }

function passthrough(text) { return { text: String(text), total: 0, counts: {} } }

function bullet(label, value) { return value ? "- " + label + ": " + value + "\n" : "" }

function buildReport(ctx) {
  var fmt = ctx.deps.fmt
  var doRedact = ctx.redact !== false
  var red = doRedact ? ctx.deps.redact : passthrough
  var totalMasked = 0
  var counts = {}

  function clean(text) {
    var r = red(text)
    totalMasked += r.total || 0
    for (var k in (r.counts || {})) counts[k] = (counts[k] || 0) + r.counts[k]
    return r.text
  }

  var meta = ctx.meta || {}
  var now = meta.generatedMs || 0
  var rows = ctx.rows || []
  var out = ""

  out += "# OmaBlackbox report\n\n"
  out += bullet("Generated", now ? fmt.dateTime(now) + " (UTC" + fmt.tzOffset(now) + ")" : "")
  out += bullet("OmaBlackbox", meta.version)
  out += bullet("Kernel", clean(meta.kernel || ""))
  out += bullet("Omarchy", clean(meta.omarchy || ""))
  out += bullet("Scanned", meta.boots !== undefined
    ? fmt.plural(meta.boots, "boot") + " over the last " + fmt.plural(meta.scanDays || 0, "day") : "")
  out += "\n"

  if (rows.length === 0) {
    out += "No hardware faults were recorded in the scanned period.\n\n"
  } else {
    out += "## Summary\n\n"
    out += "| When | Severity | What | Where | Lines |\n|---|---|---|---|---|\n"
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i]
      out += "| " + fmt.dateTime(r.lastTs / 1000) + " | " + r.sev + " | " + clean(r.title) + " | " +
        clean(r.device || "—") + " | " + (r.count ? fmt.grouped(r.count) + (r.truncated ? "+" : "") : "—") + " |\n"
    }
    out += "\n## Incidents\n\n"
    for (var j = 0; j < rows.length; j++) {
      var inc = rows[j]
      out += "### " + clean(inc.title) + " (" + inc.sev + ")\n\n"
      out += bullet("Started", fmt.dateTime(inc.firstTs / 1000))
      if (inc.lastTs !== inc.firstTs) out += bullet("Last line", fmt.dateTime(inc.lastTs / 1000))
      out += bullet("Where", clean(inc.devices && inc.devices.length ? inc.devices.join(", ") : (inc.device || "")))
      out += bullet("Detail", clean(inc.detail || ""))
      out += bullet("Lines logged", inc.count > 1 ? fmt.grouped(inc.count) + (inc.truncated ? "+ (only the start was read)" : "") : "")
      if (inc.parts && inc.parts.length > 1) {
        var seq = []
        for (var p = 0; p < inc.parts.length; p++) seq.push(clean(inc.parts[p].title))
        out += bullet("Sequence", seq.join(" → "))
      }
      out += "\n" + clean(inc.meaning || "") + "\n\n"
      if (inc.endNote) out += clean(inc.endNote) + "\n\n"
      if (inc.lines && inc.lines.length) {
        out += "```text\n"
        for (var l = 0; l < inc.lines.length; l++) {
          out += fmt.clockSec(inc.lines[l].ts / 1000) + "  " + clean(inc.lines[l].msg) + "\n"
        }
        if (inc.dropped > 0) out += "… " + fmt.grouped(inc.dropped) + (inc.truncated ? "+" : "") + " more lines omitted\n"
        out += "```\n\n"
      }
    }
  }

  if (doRedact) {
    var names = []
    for (var c in counts) names.push(counts[c] + " " + c)
    out += "---\nIdentifiers (MAC and IP addresses, UUIDs, serial numbers, e-mail addresses, home paths) " +
      "were masked automatically" + (totalMasked ? ": " + names.join(", ") : "") +
      ". This is best-effort: read the report before posting it publicly.\n"
  } else {
    out += "---\nThis report was NOT redacted. It may contain identifying values.\n"
  }
  return out
}
