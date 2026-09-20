pragma ComponentBehavior: Bound

import QtQuick
import qs.Commons
import "lib/Format.js" as Fmt
import "lib/Redact.js" as Redact
import "lib/Rules.js" as Rules

// One incident in the timeline. Collapsed it is two quiet lines (what, and
// where/how much); expanded it explains what it means, lays out the sequence,
// and shows a few log lines.
Item {
  id: root

  property var row: null
  property var pal: null
  property string fontFamily: Style.font.family
  property bool expanded: false
  property bool current: false
  property bool redact: true
  signal toggled()

  readonly property int pad: Style.space(10)
  readonly property bool isBoot: row ? row.kind === "boot" : false
  readonly property color tone: pal && row ? pal.sev(row.sev) : "white"
  readonly property int maxLogLines: 8

  width: parent ? parent.width : Style.space(300)
  height: body.implicitHeight + pad * 2

  Behavior on height { NumberAnimation { duration: 140; easing.type: Easing.OutCubic } }

  function metaText() {
    if (!row) return ""
    if (isBoot) return "The log stops at " + Fmt.clockSec(row.lastTs / 1000)
    var bits = [Rules.classLabel(row.cls)]
    var where = row.devices && row.devices.length > 0 ? row.devices.join(", ") : row.device
    if (where) bits.push(where)
    if (row.count > 1) bits.push(Fmt.grouped(row.count) + (row.truncated ? "+" : "") + " lines")
    if (row.endNote !== "") bits.push("session ended")
    return bits.join(" · ")
  }

  function partOffset(p) {
    var s = (p.ts - row.firstTs) / 1000000
    if (s <= 0) return "start"
    if (s < 1) return "+" + Math.max(1, Math.round(s * 1000)) + " ms"
    return "+" + (s < 10 ? s.toFixed(1) : Math.round(s)) + " s"
  }

  function logLines() {
    if (!expanded || !row || !row.lines) return []
    var out = []
    for (var i = 0; i < row.lines.length && i < maxLogLines; i++) {
      var l = row.lines[i]
      out.push(Fmt.clockSec(l.ts / 1000) + "  " + (redact ? Redact.redactText(l.msg) : l.msg))
    }
    return out
  }

  readonly property var shownLines: logLines()
  readonly property int moreLines: row && row.lines ? Math.max(0, row.count - shownLines.length) : 0

  Rectangle {
    anchors.fill: parent
    radius: Style.cornerRadius
    color: root.expanded ? root.pal.washStrong : ((hover.hovered || root.current) ? root.pal.wash : "transparent")
    Behavior on color { ColorAnimation { duration: 120 } }
  }

  Column {
    id: body
    x: root.pad
    y: root.pad
    width: parent.width - root.pad * 2
    spacing: Style.space(10)

    // ---- summary -----------------------------------------------------------------
    Item {
      width: parent.width
      height: Math.max(titleCol.implicitHeight, Style.space(18))

      SevMark {
        id: mark
        size: Style.space(9)
        tone: root.tone
        filled: root.row ? root.row.unread : false
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.topMargin: Style.space(4)
      }

      Column {
        id: titleCol
        anchors.left: mark.right
        anchors.leftMargin: Style.space(12)
        anchors.right: stamp.left
        anchors.rightMargin: Style.space(10)
        spacing: Style.space(2)

        Text {
          width: parent.width
          textFormat: Text.PlainText
          text: root.row ? root.row.title : ""
          color: root.pal.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          font.bold: root.row ? root.row.unread : false
          elide: Text.ElideRight
        }
        Text {
          width: parent.width
          textFormat: Text.PlainText
          text: root.metaText()
          color: root.pal.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }

      Text {
        id: stamp
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.topMargin: Style.space(1)
        textFormat: Text.PlainText
        text: root.row ? Fmt.clock(root.row.lastTs / 1000) : ""
        color: root.pal.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }

    // ---- details (expanded only) -----------------------------------------------------
    Column {
      id: details
      visible: root.expanded
      x: Style.space(21)
      width: parent.width - Style.space(21)
      spacing: Style.space(10)

      Text {
        width: parent.width
        visible: root.row && root.row.meaning !== ""
        textFormat: Text.PlainText
        text: root.row ? root.row.meaning : ""
        color: root.pal.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        wrapMode: Text.WordWrap
        lineHeight: 1.15
      }

      Text {
        width: parent.width
        visible: text !== ""
        textFormat: Text.PlainText
        text: !root.row ? "" : (root.row.endNote !== "" ? root.row.endNote : (root.isBoot ? root.row.detail : ""))
        color: root.pal.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        wrapMode: Text.WordWrap
        lineHeight: 1.15
      }

      Column {
        width: parent.width
        visible: root.row && root.row.parts && root.row.parts.length > 1
        spacing: Style.space(3)

        Repeater {
          model: root.row && root.row.parts && root.row.parts.length > 1 ? root.row.parts : []
          delegate: Row {
            id: part
            required property var modelData
            spacing: Style.space(10)
            Text {
              width: Style.space(44)
              textFormat: Text.PlainText
              text: root.partOffset(part.modelData)
              horizontalAlignment: Text.AlignRight
              color: root.pal.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
            Text {
              textFormat: Text.PlainText
              text: part.modelData.title
              color: root.pal.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }
        }
      }

      Rectangle {
        width: parent.width
        visible: root.shownLines.length > 0
        height: logColumn.implicitHeight + Style.space(14)
        radius: Style.cornerRadius
        color: root.pal.wash

        Column {
          id: logColumn
          x: Style.space(8)
          y: Style.space(7)
          width: parent.width - Style.space(16)
          spacing: Style.space(3)

          Repeater {
            model: root.shownLines
            delegate: Text {
              id: logLine
              required property string modelData
              width: logColumn.width
              textFormat: Text.PlainText
              text: logLine.modelData
              color: root.pal.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WrapAtWordBoundaryOrAnywhere
            }
          }

          Text {
            visible: root.moreLines > 0
            width: logColumn.width
            textFormat: Text.PlainText
            text: "… " + Fmt.grouped(root.moreLines) + (root.row && root.row.truncated ? "+" : "") + " more lines"
            color: root.pal.faint
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }

  HoverHandler {
    id: hover
    cursorShape: Qt.PointingHandCursor
  }

  TapHandler {
    onTapped: root.toggled()
  }
}
