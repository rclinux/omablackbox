pragma ComponentBehavior: Bound

import QtQuick
import qs.Commons
import qs.Ui
import "lib/Format.js" as Fmt

// The OmaBlackbox panel: a calm headline that says how things are, then a
// short timeline of incidents grouped by day. Nothing is shown until asked for;
// Enter or a click expands one incident.
//
// Keys: Up/Down (or j/k) move, Enter opens/closes, a = mark all read,
// c = copy report, s = save report, r = rescan, Esc = close.
Panel {
  id: root
  moduleName: "io.github.rclinux.omablackbox"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property var engine: null

  function open() { root.controller.show() }
  function close() { root.controller.hide() }
  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.hostWidget || root, direction)
    return false
  }

  // ---- state ---------------------------------------------------------------------------
  property var entries: []          // day headers and incident rows, flattened for the list
  property string expandedId: ""
  property int cursor: -1           // index into entries of the highlighted incident

  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property bool hasRows: engine ? engine.rows.length > 0 : false
  readonly property string status: engine ? engine.status : "starting"

  Tones {
    id: pal
    foreground: root.barForeground
    urgent: root.bar ? root.bar.urgent : Color.urgent
  }

  function buildEntries() {
    var out = []
    var rows = engine ? engine.rows : []
    var last = ""
    for (var i = 0; i < rows.length; i++) {
      var day = Fmt.dayLabel(rows[i].lastTs / 1000, engine.nowMs)
      if (day !== last) {
        out.push({ header: day })
        last = day
      }
      out.push({ row: rows[i] })
    }
    entries = out
    if (cursor >= out.length || (cursor >= 0 && out[cursor].header !== undefined)) cursor = firstRow()
  }

  function firstRow() {
    for (var i = 0; i < entries.length; i++) if (entries[i].row !== undefined) return i
    return -1
  }

  function moveCursor(step) {
    if (entries.length === 0) return
    var i = cursor < 0 ? (step > 0 ? -1 : entries.length) : cursor
    for (var n = 0; n < entries.length; n++) {
      i += step
      if (i < 0 || i >= entries.length) return
      if (entries[i].row !== undefined) {
        cursor = i
        list.positionViewAtIndex(i, ListView.Contain)
        return
      }
    }
  }

  function toggleAt(index) {
    if (index < 0 || index >= entries.length || entries[index].row === undefined) return
    var id = entries[index].row.id
    expandedId = expandedId === id ? "" : id
    cursor = index
  }

  onEngineChanged: buildEntries()
  onOpenedChanged: {
    if (opened) {
      buildEntries()
      if (cursor < 0) cursor = firstRow()
      // A sample-events preview opens with the first incident expanded, to show the full design.
      if (engine && engine.previewApplied === "events" && cursor >= 0 && expandedId === "") expandedId = entries[cursor].row.id
    }
  }

  Connections {
    target: root.engine
    function onRevisionChanged() { root.buildEntries() }
  }

  // ---- headline ---------------------------------------------------------------------------
  function headline() {
    if (!engine) return "Starting"
    if (status === "no-access") return "Can’t read the kernel log"
    if (status === "no-journal") return "No system journal found"
    if (status === "starting") return "Reading the kernel log"
    if (engine.unread > 0) return engine.unread === 1 ? "1 event needs a look" : engine.unread + " events need a look"
    return hasRows ? "Nothing new" : "All quiet"
  }

  function subline() {
    if (!engine) return ""
    if (status === "no-access") return "Your user isn’t allowed to read the system journal."
    if (status === "no-journal") return "OmaBlackbox reads systemd’s journal through journalctl."
    if (status === "starting") return "Looking through recent sessions…"
    if (engine.unread > 0 && engine.latestUnread)
      return engine.latestUnread.title + " · " + Fmt.ago(engine.latestUnread.lastTs / 1000, engine.nowMs)
    var since = "Watching since " + Fmt.clock(engine.bootStartMs) + " (up " + Fmt.duration(engine.nowMs - engine.bootStartMs) + ")"
    if (!hasRows) return "No hardware faults in the last " + Fmt.plural(engine.scanDays, "day") + ". " + since
    return since
  }

  readonly property color heroTone: {
    if (!engine || status === "starting") return pal.faint
    if (status === "no-access" || status === "no-journal") return pal.warning
    if (engine.unread > 0) return pal.sev(engine.worst)
    return pal.calm
  }

  // The keys that do something right now, so the panel explains itself.
  function hints() {
    if (!engine || status !== "watching") return [{ k: "esc", t: "close" }]
    var out = []
    if (hasRows) {
      out.push({ k: "↑↓", t: "move" })
      out.push({ k: "enter", t: "open" })
    }
    if (engine.unread > 0) out.push({ k: "a", t: "mark all read" })
    if (hasRows) {
      out.push({ k: "c", t: "copy report" })
      out.push({ k: "s", t: "save report" })
    }
    if (!engine.busy) out.push({ k: "r", t: "rescan" })
    out.push({ k: "esc", t: "close" })
    return out
  }

  function footline() {
    if (!engine) return ""
    if (engine.toast !== "") return engine.toast
    var bits = []
    if (status === "watching") {
      bits.push(Fmt.plural(engine.bootsScanned, "session") + " · " + Fmt.plural(engine.scanDays, "day"))
      if (engine.hiddenCount > 0) bits.push(engine.hiddenCount + " minor hidden")
      if (engine.onlyOneBoot) bits.push("earlier sessions aren’t kept in the journal")
    }
    return bits.join(" · ")
  }

  // ---- layout ---------------------------------------------------------------------------------
  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(470))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) { if (dy !== 0) root.moveCursor(dy > 0 ? 1 : -1) }
      // Enter fires both returnRequested and activateRequested; Space only the latter.
      // Handling both would toggle twice and cancel out, so handle activate alone.
      onActivateRequested: root.toggleAt(root.cursor)
      onTextKey: function(text) {
        if (!root.engine) return
        if (text === "a") root.engine.acknowledgeAll()
        else if (text === "c") root.engine.copyReport()
        else if (text === "s") root.engine.saveReportFile()
        else if (text === "r") root.engine.refresh()
      }

      Column {
        id: content
        width: parent.width
        spacing: Style.space(12)

        // ---- hero ---------------------------------------------------------------------------
        Item {
          width: parent.width
          height: Math.max(heroText.implicitHeight, actions.height) + Style.space(4)

          SevMark {
            id: heroMark
            size: Style.space(14)
            tone: root.heroTone
            filled: root.engine ? (root.engine.unread > 0 || root.status === "no-access" || root.status === "no-journal") : false
            pulse: root.engine ? (root.engine.worst === "critical" && root.engine.unread > 0) : false
            anchors.left: parent.left
            anchors.leftMargin: Style.space(4)
            anchors.top: parent.top
            anchors.topMargin: Style.space(7)
          }

          Column {
            id: heroText
            anchors.left: heroMark.right
            anchors.leftMargin: Style.space(14)
            anchors.right: actions.visible ? actions.left : parent.right
            anchors.rightMargin: actions.visible ? Style.space(10) : Style.space(4)
            spacing: Style.space(3)

            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: root.headline()
              color: root.barForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
            }
            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: root.subline()
              color: pal.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
              lineHeight: 1.1
            }
          }

          Row {
            id: actions
            anchors.right: parent.right
            anchors.top: parent.top
            spacing: Style.space(2)
            visible: root.status === "watching"

            PanelActionButton {
              iconText: ""
              tooltipText: "Mark all read  (a)"
              foreground: root.barForeground
              fontFamily: root.fontFamily
              enabled: root.engine ? root.engine.unread > 0 : false
              opacity: enabled ? 1 : 0.35
              onClicked: root.engine.acknowledgeAll()
            }
            PanelActionButton {
              iconText: ""
              tooltipText: "Copy report, identifiers masked  (c)"
              foreground: root.barForeground
              fontFamily: root.fontFamily
              enabled: root.hasRows
              opacity: enabled ? 1 : 0.35
              onClicked: root.engine.copyReport()
            }
            PanelActionButton {
              iconText: ""
              tooltipText: "Save report to a file  (s)"
              foreground: root.barForeground
              fontFamily: root.fontFamily
              enabled: root.hasRows
              opacity: enabled ? 1 : 0.35
              onClicked: root.engine.saveReportFile()
            }
            PanelActionButton {
              iconText: ""
              tooltipText: "Rescan the journal  (r)"
              foreground: root.barForeground
              fontFamily: root.fontFamily
              enabled: root.engine ? !root.engine.busy : false
              opacity: enabled ? 1 : 0.35
              onClicked: root.engine.refresh()
            }
          }
        }

        // ---- what to do when the journal can't be read ------------------------------------
        Rectangle {
          width: parent.width
          visible: root.status === "no-access"
          height: fix.implicitHeight + Style.space(20)
          radius: Style.cornerRadius
          color: pal.wash

          Text {
            id: fix
            x: Style.space(12)
            y: Style.space(10)
            width: parent.width - Style.space(24)
            textFormat: Text.PlainText
            text: "Add yourself to the journal group, then log out and back in:\n\nsudo usermod -aG systemd-journal $USER"
            color: pal.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }
        }

        // ---- timeline -----------------------------------------------------------------------------
        PanelSeparator {
          foreground: root.barForeground
          visible: root.hasRows
        }

        ListView {
          id: list
          width: parent.width
          visible: root.hasRows
          height: root.hasRows ? Math.min(contentHeight, Style.space(400)) : 0
          clip: true
          model: root.entries
          spacing: Style.space(2)
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height
          reuseItems: false

          delegate: Item {
            id: cell
            required property var modelData
            required property int index
            readonly property bool isHeader: modelData.header !== undefined
            width: list.width
            height: isHeader ? headerLabel.implicitHeight + Style.space(14) : incident.height

            Text {
              id: headerLabel
              visible: cell.isHeader
              x: Style.space(10)
              y: Style.space(10)
              textFormat: Text.PlainText
              text: cell.isHeader ? cell.modelData.header.toUpperCase() : ""
              color: pal.faint
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1
            }

            IncidentRow {
              id: incident
              visible: !cell.isHeader
              width: parent.width
              row: cell.isHeader ? null : cell.modelData.row
              pal: pal
              fontFamily: root.fontFamily
              expanded: !cell.isHeader && root.expandedId === cell.modelData.row.id
              current: root.cursor === cell.index
              redact: root.engine ? root.engine.redactEnabled : true
              onToggled: root.toggleAt(cell.index)
            }
          }
        }

        // ---- footer -------------------------------------------------------------------------------
        PanelSeparator {
          foreground: root.barForeground
          visible: root.footline() !== "" || root.status === "watching"
        }

        Text {
          width: parent.width
          visible: text !== ""
          textFormat: Text.PlainText
          text: root.footline()
          color: root.engine && root.engine.toast !== "" ? pal.calm : pal.faint
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WrapAnywhere
          leftPadding: Style.space(4)
        }

        Flow {
          width: parent.width
          leftPadding: Style.space(4)
          spacing: Style.space(10)
          visible: root.status === "watching"

          Repeater {
            model: root.hints()
            delegate: Row {
              id: hint
              required property var modelData
              spacing: Style.space(5)

              Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                width: Math.max(Style.space(16), keyLabel.implicitWidth + Style.space(8))
                height: keyLabel.implicitHeight + Style.space(4)
                radius: Style.cornerRadius
                color: pal.wash
                border.width: 1
                border.color: pal.hairline

                Text {
                  id: keyLabel
                  anchors.centerIn: parent
                  textFormat: Text.PlainText
                  text: hint.modelData.k
                  color: pal.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                }
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: hint.modelData.t
                color: pal.faint
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }
        }
      }
    }
  }
}
