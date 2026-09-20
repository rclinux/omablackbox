.pragma library

// Best-effort removal of identifying values from kernel log text before it is
// displayed, copied, or saved. Kernel messages routinely carry MAC and IP
// addresses (firewall logs), GPU and disk UUIDs, serial numbers and home
// paths. The aim is that an exported report can be pasted into a public bug
// report without a leak. PCI addresses, driver versions, error codes and
// timestamps are deliberately kept: they are what makes a report useful.
//
// Pure JavaScript, no QML dependency, so it can be unit tested under Node.

var IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)"

var RULES = [
  { name: "email", re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, to: "<email>" },
  {
    name: "uuid",
    re: /\b(GPU-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    to: function (m, prefix) { return (prefix || "") + "<uuid>" }
  },
  // Six or more hex octets: covers 6-byte MACs and the 14-byte header inside
  // firewall log MAC= fields.
  { name: "mac", re: /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5,}\b/gi, to: "<mac>" },
  {
    name: "ip",
    re: new RegExp("\\b" + IPV4_OCTET + "(?:\\." + IPV4_OCTET + "){3}\\b(?!\\.\\d)", "g"),
    to: "<ip>"
  },
  { name: "ip", re: /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi, to: "<ip>" },
  {
    name: "ip",
    re: /(^|[^\w:])((?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}))(?![\w:])/gi,
    to: function (m, lead) { return lead + "<ip>" }
  },
  {
    name: "serial",
    re: /\b(serial(?: number| no\.?)?)( is |[:=] ?)([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?)/gi,
    to: function (m, key, sep) { return key + sep + "<serial>" }
  },
  {
    name: "serial",
    re: /\b(S\/N|SN)([:=] ?)([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?)/g,
    to: function (m, key, sep) { return key + sep + "<serial>" }
  },
  { name: "id", re: /\bwwn-0x[0-9a-f]+\b/gi, to: "wwn-<id>" },
  { name: "id", re: /\bby-id\/[^\s'")]+/g, to: "by-id/<id>" },
  { name: "path", re: /\/home\/[^\/\s:'")]+/g, to: "/home/<user>" }
]

// Returns { text, counts, total } where counts maps rule name -> replacements.
function redact(input) {
  var text = String(input === undefined || input === null ? "" : input)
  var counts = {}
  var total = 0
  for (var i = 0; i < RULES.length; i++) {
    var r = RULES[i]
    text = text.replace(r.re, function () {
      counts[r.name] = (counts[r.name] || 0) + 1
      total += 1
      return typeof r.to === "function" ? r.to.apply(null, arguments) : r.to
    })
  }
  return { text: text, counts: counts, total: total }
}

function redactText(input) {
  return redact(input).text
}

// Redacts many strings and merges their counts.
function redactMany(list) {
  var out = []
  var counts = {}
  var total = 0
  for (var i = 0; i < list.length; i++) {
    var r = redact(list[i])
    out.push(r.text)
    total += r.total
    for (var k in r.counts) counts[k] = (counts[k] || 0) + r.counts[k]
  }
  return { list: out, counts: counts, total: total }
}

function describeCounts(counts) {
  var names = []
  for (var k in counts) names.push(counts[k] + " " + k)
  return names.join(", ")
}
