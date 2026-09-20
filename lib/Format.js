.pragma library

// Small, locale-independent date and duration formatting for the panel and
// reports. All inputs are milliseconds since the epoch. Local time is used for
// display, matching the Omarchy clock.

var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function pad2(n) { return (n < 10 ? "0" : "") + n }

function clock(ms) {
  var d = new Date(ms)
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes())
}

function clockSec(ms) {
  var d = new Date(ms)
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds())
}

function dateTime(ms) {
  var d = new Date(ms)
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + clockSec(ms)
}

// "+02:00" / "-04:00" / "+00:00"
function tzOffset(ms) {
  var off = -new Date(ms).getTimezoneOffset()
  var sign = off < 0 ? "-" : "+"
  var a = Math.abs(off)
  return sign + pad2(Math.floor(a / 60)) + ":" + pad2(a % 60)
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

// "Today", "Yesterday", or "Fri 18 Sep"
function dayLabel(ms, nowMs) {
  var d = new Date(ms)
  var now = new Date(nowMs)
  if (sameDay(d, now)) return "Today"
  var y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (sameDay(d, y)) return "Yesterday"
  return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()]
}

// "just now", "4 min ago", "3 h ago", "2 d ago"
function ago(ms, nowMs) {
  var s = Math.max(0, Math.round((nowMs - ms) / 1000))
  if (s < 45) return "just now"
  var m = Math.round(s / 60)
  if (m < 60) return m + " min ago"
  var h = Math.round(m / 60)
  if (h < 36) return h + " h ago"
  return Math.round(h / 24) + " d ago"
}

// "45 s", "12 min", "4 h 33 min", "2 d 3 h"
function duration(ms) {
  var s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return s + " s"
  var m = Math.floor(s / 60)
  if (m < 60) return m + " min"
  var h = Math.floor(m / 60)
  if (h < 24) return h + " h" + (m % 60 ? " " + (m % 60) + " min" : "")
  var d = Math.floor(h / 24)
  return d + " d" + (h % 24 ? " " + (h % 24) + " h" : "")
}

// 20000 -> "20,000"
function grouped(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

function plural(n, one, many) {
  return n + " " + (n === 1 ? one : (many || one + "s"))
}
