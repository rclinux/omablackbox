import QtQuick
import qs.Commons
import qs.Ui

// The bar entry: a single quiet dot. Hollow and dim while everything is fine;
// filled in the severity colour (with a count when there is more than one) when
// something needs attention. Click opens the panel.
BarWidget {
  id: root
  moduleName: "io.github.rclinux.omablackbox"

  // ---- the shared engine (the `service` half of this plugin) -----------------------
  // Preferred: the single service instance the shell keeps for us, so several
  // monitors share one journal follower. If the host cannot hand it over, fall
  // back to a private engine so the widget still works.
  readonly property var sharedEngine: {
    var host = bar && bar.shell ? bar.shell : null
    if (!host) return null
    var found = null
    if (typeof host.firstPartyServiceFor === "function") found = host.firstPartyServiceFor(moduleName)
    if (!found && typeof host.serviceFor === "function") found = host.serviceFor(moduleName)
    return found ? found : null
  }
  property bool graceOver: false
  readonly property var engine: sharedEngine ? sharedEngine : (localEngine.item ? localEngine.item : null)

  Timer {
    interval: 2500
    running: true
    repeat: false
    onTriggered: root.graceOver = true
  }

  Loader {
    id: localEngine
    active: root.graceOver && root.sharedEngine === null
    source: Qt.resolvedUrl("Service.qml")
    visible: false
    onLoaded: console.warn("OmaBlackbox: shared service unavailable, running a private engine")
  }

  onEngineChanged: pushSettings()
  onSettingsChanged: pushSettings()
  function pushSettings() {
    if (engine && typeof engine.applySettings === "function") engine.applySettings(root.settings)
  }

  // ---- panel plumbing (same contract as the built-in plugins) ----------------------------
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    target.bar = root.bar
    target.anchorItem = button
    target.hostWidget = root
    target.engine = root.engine
  }

  onBarChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  Connections {
    target: root
    function onEngineChanged() { root.injectPanel() }
  }

  // ---- look ------------------------------------------------------------------------
  Tones {
    id: pal
    foreground: root.bar ? root.bar.barForeground : Color.foreground
    urgent: root.bar ? root.bar.urgent : Color.urgent
  }

  readonly property string worst: engine ? engine.worst : ""
  readonly property int unread: engine ? engine.unread : 0
  readonly property bool attention: unread > 0
  readonly property bool unavailable: engine ? (engine.status === "no-access" || engine.status === "no-journal") : false
  readonly property bool hideWhenClear: setting("showWhenClear", true) === false
  readonly property bool animate: (setting("animate", true) !== false) && (bar ? bar.foregroundAnimationEnabled !== false : true)
  readonly property color tone: attention ? pal.sev(worst) : (unavailable ? pal.warning : pal.faint)

  visible: !(hideWhenClear && !attention && !unavailable)
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    keepSpace: true
    hasVisualContent: true
    fixedWidth: root.vertical ? -1 : Math.ceil(mark.implicitWidth + Style.spaceReal(17))
    tooltipText: root.engine ? root.engine.tooltip : "OmaBlackbox"
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.LeftButton) root.toggle()
    }

    Grid {
      id: mark
      anchors.centerIn: parent
      columns: root.vertical ? 1 : 2
      spacing: Style.space(5)
      horizontalItemAlignment: Grid.AlignHCenter
      verticalItemAlignment: Grid.AlignVCenter

      SevMark {
        size: Style.space(8)
        tone: root.tone
        filled: root.attention || root.unavailable
        pulse: root.animate && root.attention && root.worst === "critical" && !root.opened
        opacity: root.attention || root.unavailable ? 1.0 : 0.85
      }

      Text {
        visible: root.unread > 1
        textFormat: Text.PlainText
        text: root.unread > 99 ? "99+" : String(root.unread)
        color: root.tone
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: Style.font.caption
        font.bold: true
        renderType: Text.NativeRendering
      }
    }
  }
}
