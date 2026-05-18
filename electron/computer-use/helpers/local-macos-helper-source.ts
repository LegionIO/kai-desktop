export const LOCAL_MACOS_HELPER_SOURCE = String.raw`
import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit

let syntheticEventTag: Int64 = 0x4C47494F
let syntheticSource = CGEventSource(stateID: .privateState)
let maxKeyboardRepeatCount = 120
let blindKeyboardTextChunkSize = 512

func printJson(_ value: Any) {
  if let data = try? JSONSerialization.data(withJSONObject: value, options: []),
     let string = String(data: data, encoding: .utf8) {
    print(string)
    fflush(stdout)
  }
}

func primaryDisplayID() -> CGDirectDisplayID {
  CGMainDisplayID()
}

func displaySortPrecedes(_ lhsFrame: CGRect, _ rhsFrame: CGRect, lhsID: CGDirectDisplayID, rhsID: CGDirectDisplayID) -> Bool {
  if lhsFrame.origin.x != rhsFrame.origin.x {
    return lhsFrame.origin.x < rhsFrame.origin.x
  }
  if lhsFrame.origin.y != rhsFrame.origin.y {
    return lhsFrame.origin.y < rhsFrame.origin.y
  }
  return lhsID < rhsID
}

/// Get all active displays sorted by global position in a stable order.
func allDisplaysSorted() -> [CGDirectDisplayID] {
  var displayCount: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &displayCount)
  guard displayCount > 0 else { return [primaryDisplayID()] }
  var displays = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
  CGGetActiveDisplayList(displayCount, &displays, &displayCount)
  displays = Array(displays.prefix(Int(displayCount)))
  displays.sort {
    displaySortPrecedes(CGDisplayBounds($0), CGDisplayBounds($1), lhsID: $0, rhsID: $1)
  }
  return displays
}

/// Build display info dictionary for a given display.
func displayInfoDict(_ displayId: CGDirectDisplayID) -> [String: Any] {
  let bounds = CGDisplayBounds(displayId)
  let pixelWidth = Int(CGDisplayPixelsWide(displayId))
  let pixelHeight = Int(CGDisplayPixelsHigh(displayId))
  let logicalWidth = Int(bounds.width.rounded())
  let logicalHeight = Int(bounds.height.rounded())
  let globalX = Int(bounds.origin.x.rounded())
  let globalY = Int(bounds.origin.y.rounded())
  let scaleFactor = pixelWidth > 0 && logicalWidth > 0 ? Double(pixelWidth) / Double(logicalWidth) : 1.0

  var name = "Display \(displayId)"
  for screen in NSScreen.screens {
    if let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID,
       screenNumber == displayId {
      name = screen.localizedName
      break
    }
  }

  return [
    "displayId": String(displayId),
    "name": name,
    "pixelWidth": pixelWidth,
    "pixelHeight": pixelHeight,
    "logicalWidth": logicalWidth,
    "logicalHeight": logicalHeight,
    "globalX": globalX,
    "globalY": globalY,
    "scaleFactor": scaleFactor,
    "isPrimary": displayId == CGMainDisplayID(),
  ]
}

@available(macOS 12.3, *)
func displayInfoDict(_ display: SCDisplay) -> [String: Any] {
  let displayId = display.displayID
  let frame = display.frame
  let pixelWidth = max(1, Int(CGDisplayPixelsWide(displayId)))
  let pixelHeight = max(1, Int(CGDisplayPixelsHigh(displayId)))
  let fallbackBounds = CGDisplayBounds(displayId)
  let logicalWidth = Int((frame.width > 0 ? frame.width : fallbackBounds.width).rounded())
  let logicalHeight = Int((frame.height > 0 ? frame.height : fallbackBounds.height).rounded())
  let globalX = Int((frame.width > 0 ? frame.origin.x : fallbackBounds.origin.x).rounded())
  let globalY = Int((frame.height > 0 ? frame.origin.y : fallbackBounds.origin.y).rounded())
  let scaleFactor = pixelWidth > 0 && logicalWidth > 0 ? Double(pixelWidth) / Double(logicalWidth) : 1.0

  var name = "Display \(displayId)"
  for screen in NSScreen.screens {
    if let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID,
       screenNumber == displayId {
      name = screen.localizedName
      break
    }
  }

  return [
    "displayId": String(displayId),
    "name": name,
    "pixelWidth": pixelWidth,
    "pixelHeight": pixelHeight,
    "logicalWidth": logicalWidth,
    "logicalHeight": logicalHeight,
    "globalX": globalX,
    "globalY": globalY,
    "scaleFactor": scaleFactor,
    "isPrimary": displayId == CGMainDisplayID(),
  ]
}

func buildDisplayLayoutArray() -> [[String: Any]] {
  return allDisplaysSorted().map { displayInfoDict($0) }
}

@available(macOS 12.3, *)
func buildDisplayLayoutArray(_ displays: [SCDisplay]) -> [[String: Any]] {
  return displays.map { displayInfoDict($0) }
}

func desktopBounds() -> CGRect {
  CGDisplayBounds(primaryDisplayID())
}

func desktopCoordinateWidth() -> Int {
  Int(desktopBounds().width.rounded())
}

func desktopCoordinateHeight() -> Int {
  Int(desktopBounds().height.rounded())
}

func desktopPixelWidth() -> Int {
  Int(CGDisplayPixelsWide(primaryDisplayID()))
}

func desktopPixelHeight() -> Int {
  Int(CGDisplayPixelsHigh(primaryDisplayID()))
}

func convertTopLeftToQuartz(_ x: Double, _ y: Double) -> CGPoint {
  let bounds = desktopBounds()
  return CGPoint(x: bounds.minX + x, y: bounds.minY + y)
}

func convertQuartzToTopLeft(_ x: Double, _ y: Double) -> CGPoint {
  let bounds = desktopBounds()
  return CGPoint(x: x - bounds.minX, y: y - bounds.minY)
}

func currentPointerTopLeft() -> CGPoint {
  guard let event = CGEvent(source: nil) else {
    return CGPoint(x: 0, y: 0)
  }
  let location = event.location
  return convertQuartzToTopLeft(location.x, location.y)
}

@discardableResult
func sleepMillis(_ ms: Int) -> Bool {
  if ms <= 0 { return true }
  usleep(useconds_t(ms * 1000))
  return true
}

func parseIntArg(_ args: [String], _ index: Int, default value: Int) -> Int {
  guard args.count > index, let parsed = Int(args[index]) else {
    return value
  }
  return parsed
}

enum PointerMovementPath: String {
  case teleport = "teleport"
  case direct = "direct"
  case horizontalFirst = "horizontal-first"
  case verticalFirst = "vertical-first"
}

func parseMovementPathArg(_ args: [String], _ index: Int, default value: PointerMovementPath = .teleport) -> PointerMovementPath {
  guard args.count > index else {
    return value
  }
  return PointerMovementPath(rawValue: args[index]) ?? value
}

func makeMouseEvent(_ type: CGEventType, x: Double, y: Double, button: CGMouseButton = .left, clickState: Int64? = nil) -> CGEvent? {
  let point = convertTopLeftToQuartz(x, y)
  let event = CGEvent(mouseEventSource: syntheticSource, mouseType: type, mouseCursorPosition: point, mouseButton: button)
  event?.setIntegerValueField(.eventSourceUserData, value: syntheticEventTag)
  if let clickState {
    event?.setIntegerValueField(.mouseEventClickState, value: clickState)
  }
  return event
}

func postMouse(_ type: CGEventType, x: Double, y: Double, button: CGMouseButton = .left, clickState: Int64? = nil) {
  guard let event = makeMouseEvent(type, x: x, y: y, button: button, clickState: clickState) else {
    return
  }
  event.post(tap: .cghidEventTap)
}

func warpPointer(to point: CGPoint) {
  CGWarpMouseCursorPosition(convertTopLeftToQuartz(point.x, point.y))
}

func animatePointerSegment(from start: CGPoint, to end: CGPoint, durationMs: Int, steps: Int, dragMode: Bool = false) {
  let effectiveSteps = max(1, steps)
  let totalDuration = max(0, durationMs)
  let pauseMs = effectiveSteps > 0 ? max(1, totalDuration / effectiveSteps) : 0
  for step in 1...effectiveSteps {
    let progress = Double(step) / Double(effectiveSteps)
    let x = start.x + ((end.x - start.x) * progress)
    let y = start.y + ((end.y - start.y) * progress)
    postMouse(dragMode ? .leftMouseDragged : .mouseMoved, x: x, y: y)
    _ = sleepMillis(pauseMs)
  }
}

func animatePointerMove(from start: CGPoint, to end: CGPoint, durationMs: Int, steps: Int, path: PointerMovementPath = .teleport, dragMode: Bool = false) {
  if path == .teleport {
    if dragMode {
      postMouse(.leftMouseDragged, x: end.x, y: end.y)
      return
    }
    warpPointer(to: end)
    return
  }

  let dx = end.x - start.x
  let dy = end.y - start.y
  let absX = abs(dx)
  let absY = abs(dy)

  if path == .direct || absX < 2 || absY < 2 {
    animatePointerSegment(from: start, to: end, durationMs: durationMs, steps: steps, dragMode: dragMode)
    return
  }

  let corner = path == .horizontalFirst
    ? CGPoint(x: end.x, y: start.y)
    : CGPoint(x: start.x, y: end.y)
  let totalDistance = max(1, absX + absY)
  let firstDistance = path == .horizontalFirst ? absX : absY
  let firstRatio = firstDistance / totalDistance
  let totalDuration = max(2, durationMs)
  let totalSteps = max(2, steps)
  let firstDuration = max(1, Int(Double(totalDuration) * firstRatio))
  let secondDuration = max(1, totalDuration - firstDuration)
  let firstSteps = max(1, Int(Double(totalSteps) * firstRatio))
  let secondSteps = max(1, totalSteps - firstSteps)

  animatePointerSegment(from: start, to: corner, durationMs: firstDuration, steps: firstSteps, dragMode: dragMode)
  animatePointerSegment(from: corner, to: end, durationMs: secondDuration, steps: secondSteps, dragMode: dragMode)
}

func dragPointer(from start: CGPoint, to end: CGPoint, durationMs: Int, steps: Int, path: PointerMovementPath = .teleport) {
  if path == .teleport {
    warpPointer(to: start)
  } else {
    postMouse(.mouseMoved, x: start.x, y: start.y)
  }
  postMouse(.leftMouseDown, x: start.x, y: start.y)
  animatePointerMove(from: start, to: end, durationMs: durationMs, steps: steps, path: path, dragMode: true)
  postMouse(.leftMouseUp, x: end.x, y: end.y)
}

func postKeyboardEvent(keyCode: CGKeyCode, keyDown: Bool, flags: CGEventFlags = []) {
  guard let event = CGEvent(keyboardEventSource: syntheticSource, virtualKey: keyCode, keyDown: keyDown) else {
    return
  }
  event.flags = flags
  event.setIntegerValueField(.eventSourceUserData, value: syntheticEventTag)
  event.post(tap: .cghidEventTap)
}

func postUnicodeText(_ text: String, flags: CGEventFlags = []) {
  let utf16View = Array(text.utf16)
  guard !utf16View.isEmpty,
        let keyDown = CGEvent(keyboardEventSource: syntheticSource, virtualKey: 0, keyDown: true),
        let keyUp = CGEvent(keyboardEventSource: syntheticSource, virtualKey: 0, keyDown: false) else {
    return
  }
  keyDown.flags = flags
  keyUp.flags = flags
  keyDown.keyboardSetUnicodeString(stringLength: utf16View.count, unicodeString: utf16View)
  keyUp.keyboardSetUnicodeString(stringLength: utf16View.count, unicodeString: utf16View)
  keyDown.setIntegerValueField(.eventSourceUserData, value: syntheticEventTag)
  keyUp.setIntegerValueField(.eventSourceUserData, value: syntheticEventTag)
  keyDown.post(tap: .cghidEventTap)
  keyUp.post(tap: .cghidEventTap)
}

func postUnicodeTextInChunks(
  _ text: String,
  chunkSize: Int = 16,
  delayMs: Int = 5,
  targetPid: pid_t? = nil,
  expectedElementSignature: String? = nil
) -> Bool {
  let maxUtf16Units = max(1, chunkSize)
  var chunk = ""
  var chunkUnits = 0

  func flushChunk() -> Bool {
    if chunk.isEmpty { return true }
    guard frontmostMatchesPid(targetPid) else { return false }
    guard focusedTextElementMatchesExpected(pid: targetPid, expectedSignature: expectedElementSignature) else { return false }
    postUnicodeText(chunk)
    _ = sleepMillis(delayMs)
    chunk = ""
    chunkUnits = 0
    return true
  }

  for character in text {
    let characterText = String(character)
    let characterUnits = characterText.utf16.count
    if !chunk.isEmpty && chunkUnits + characterUnits > maxUtf16Units {
      guard flushChunk() else { return false }
    }
    chunk += characterText
    chunkUnits += characterUnits
  }

  return flushChunk()
}

func frontmostApplicationPid() -> pid_t? {
  NSWorkspace.shared.frontmostApplication?.processIdentifier
}

func frontmostApplicationInfo() -> [String: Any]? {
  guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
  return [
    "ok": true,
    "pid": app.processIdentifier,
    "name": app.localizedName ?? "",
    "bundleId": app.bundleIdentifier ?? ""
  ]
}

func frontmostMatchesPid(_ pid: pid_t?) -> Bool {
  guard let pid else { return true }
  return frontmostApplicationPid() == pid
}

func pressKeyRepeated(
  keyCode: CGKeyCode,
  count: Int,
  delayMs: Int = 2,
  targetPid: pid_t? = nil,
  expectedElementSignature: String? = nil
) -> Bool {
  if count <= 0 { return true }
  for _ in 0..<count {
    guard frontmostMatchesPid(targetPid) else { return false }
    guard focusedTextElementMatchesExpected(pid: targetPid, expectedSignature: expectedElementSignature) else { return false }
    postKeyboardEvent(keyCode: keyCode, keyDown: true)
    postKeyboardEvent(keyCode: keyCode, keyDown: false)
    _ = sleepMillis(delayMs)
  }
  return true
}

func operationCount(_ operation: [String: Any]) -> Int? {
  let count: Int
  if let rawCount = operation["count"] as? Int {
    count = rawCount
  } else if let number = operation["count"] as? NSNumber {
    count = number.intValue
  } else {
    return nil
  }
  guard count >= 0 && count <= maxKeyboardRepeatCount else { return nil }
  return count
}

func validatePatchOperations(_ operations: [[String: Any]]) -> String? {
  for operation in operations {
    guard let kind = operation["kind"] as? String else {
      return "Patch operation missing kind"
    }

    switch kind {
    case "moveLeft", "moveRight", "deleteForward":
      guard operationCount(operation) != nil else {
        return "\(kind) missing, negative, or excessive count"
      }
    case "insertText":
      guard operation["text"] as? String != nil else {
        return "insertText missing text"
      }
    default:
      return "Unknown patch operation: \(kind)"
    }
  }
  return nil
}

func focusedAccessibilityElement() -> AXUIElement? {
  let systemWide = AXUIElementCreateSystemWide()
  var focusedValue: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute as CFString, &focusedValue)
  guard error == .success, let focusedValue else {
    return nil
  }
  return (focusedValue as! AXUIElement)
}

func focusedAccessibilityElementForPid(_ pid: pid_t) -> AXUIElement? {
  let appElement = AXUIElementCreateApplication(pid)
  var focusedValue: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &focusedValue)
  guard error == .success, let focusedValue else {
    return nil
  }
  return (focusedValue as! AXUIElement)
}

func focusedAccessibilityElement(pid: pid_t? = nil) -> AXUIElement? {
  if let pid {
    return focusedAccessibilityElementForPid(pid)
  }
  return focusedAccessibilityElement()
}

func focusedTextTargetIsSecure(pid: pid_t? = nil) -> Bool {
  guard let element = focusedAccessibilityElement(pid: pid) else {
    return false
  }

  var subroleValue: CFTypeRef?
  let subroleErr = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subroleValue)
  if subroleErr == .success,
     let subrole = subroleValue as? String,
     subrole == (kAXSecureTextFieldSubrole as String) {
    return true
  }

  var protectedValue: CFTypeRef?
  let protectedErr = AXUIElementCopyAttributeValue(element, "AXProtectedContent" as CFString, &protectedValue)
  if protectedErr == .success,
     let protected = protectedValue as? Bool,
     protected {
    return true
  }

  return false
}

func focusedTextValue(pid: pid_t? = nil) -> String? {
  guard let element = focusedAccessibilityElement(pid: pid) else {
    return nil
  }
  var value: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value)
  guard error == .success, let valueString = value as? String else {
    return nil
  }
  return valueString
}

func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
  var value: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
  guard error == .success, let value else {
    return nil
  }
  return value as? String
}

func pointAttribute(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
  var value: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
  guard error == .success,
        let value,
        CFGetTypeID(value) == AXValueGetTypeID() else {
    return nil
  }
  let axValue = value as! AXValue
  guard AXValueGetType(axValue) == .cgPoint else {
    return nil
  }
  var point = CGPoint.zero
  guard AXValueGetValue(axValue, .cgPoint, &point) else {
    return nil
  }
  return point
}

func sizeAttribute(_ element: AXUIElement, _ attribute: String) -> CGSize? {
  var value: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
  guard error == .success,
        let value,
        CFGetTypeID(value) == AXValueGetTypeID() else {
    return nil
  }
  let axValue = value as! AXValue
  guard AXValueGetType(axValue) == .cgSize else {
    return nil
  }
  var size = CGSize.zero
  guard AXValueGetValue(axValue, .cgSize, &size) else {
    return nil
  }
  return size
}

func signatureComponent(_ value: String?) -> String {
  guard let value else { return "" }
  return Data(value.utf8).base64EncodedString()
}

func accessibilityElementSignature(_ element: AXUIElement) -> String? {
  guard let role = stringAttribute(element, kAXRoleAttribute as String) else {
    return nil
  }

  let subrole = stringAttribute(element, kAXSubroleAttribute as String)
  let identifier = stringAttribute(element, "AXIdentifier")
  let position = pointAttribute(element, kAXPositionAttribute as String)
  let size = sizeAttribute(element, kAXSizeAttribute as String)

  guard identifier != nil || (position != nil && size != nil) else {
    return nil
  }

  var parts = [
    "role=\(signatureComponent(role))",
    "subrole=\(signatureComponent(subrole))",
    "id=\(signatureComponent(identifier))",
  ]

  if let position {
    parts.append("x=\(Int(position.x.rounded()))")
    parts.append("y=\(Int(position.y.rounded()))")
  }
  if let size {
    parts.append("w=\(Int(size.width.rounded()))")
  }

  return parts.joined(separator: "|")
}

func focusedTextElementSignature(pid: pid_t? = nil) -> String? {
  guard let element = focusedAccessibilityElement(pid: pid) else {
    return nil
  }
  return accessibilityElementSignature(element)
}

func expectedElementSignatureArg(_ args: [String], _ index: Int) -> String? {
  guard args.count > index,
        !args[index].isEmpty else {
    return nil
  }
  return decodeBase64String(args[index])
}

func allowsUnverifiedKeyboardTarget(_ args: [String]) -> Bool {
  args.contains("--allow-unverified-keyboard")
}

func elementMatchesExpected(_ element: AXUIElement, expectedSignature: String?) -> Bool {
  guard let expectedSignature else {
    return true
  }
  return accessibilityElementSignature(element) == expectedSignature
}

func focusedTextElementMatchesExpected(pid: pid_t? = nil, expectedSignature: String?) -> Bool {
  guard let expectedSignature else {
    return true
  }
  guard let element = focusedAccessibilityElement(pid: pid) else {
    return false
  }
  return elementMatchesExpected(element, expectedSignature: expectedSignature)
}

func utf16Slice(_ text: String, location: Int, length: Int) -> String? {
  guard location >= 0, length >= 0 else { return nil }
  let utf16View = text.utf16
  let textLength = utf16View.count
  guard location <= textLength, length <= textLength - location else {
    return nil
  }
  let startUtf16 = utf16View.index(utf16View.startIndex, offsetBy: location)
  let endUtf16 = utf16View.index(startUtf16, offsetBy: length)
  guard let start = String.Index(startUtf16, within: text),
        let end = String.Index(endUtf16, within: text) else {
    return nil
  }
  return String(text[start..<end])
}

func focusedSelectedTextRange(pid: pid_t? = nil) -> CFRange? {
  let element = focusedAccessibilityElement(pid: pid)
  guard let element else {
    return nil
  }
  var rangeValue: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &rangeValue)
  guard error == .success,
        let rangeValue,
        CFGetTypeID(rangeValue) == AXValueGetTypeID() else {
    return nil
  }
  let axValue = rangeValue as! AXValue
  guard AXValueGetType(axValue) == .cfRange else {
    return nil
  }
  var range = CFRange(location: 0, length: 0)
  guard AXValueGetValue(axValue, .cfRange, &range) else {
    return nil
  }
  return range
}

func setFocusedSelectedTextRange(location: Int, length: Int, pid: pid_t? = nil) -> Bool {
  let element = focusedAccessibilityElement(pid: pid)
  guard location >= 0, length >= 0, let element else {
    return false
  }
  var range = CFRange(location: location, length: length)
  guard let rangeValue = AXValueCreate(.cfRange, &range) else {
    return false
  }
  let error = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, rangeValue)
  return error == .success
}

/// Atomically replace a text range by setting kAXValueAttribute on the focused element.
/// This avoids the two-step "set selection then type" approach which races with the app.
/// Returns a dictionary with result info:
///   - "method": "value" if kAXValueAttribute was used successfully
///   - "method": "select_type" if fell back to selection + typing (with verification)
///   - nil if both methods failed
func replaceTextRangeAtomically(
  location: Int,
  length: Int,
  newText: String,
  pid: pid_t? = nil,
  expectedElementSignature: String? = nil
) -> [String: Any]? {
  guard frontmostMatchesPid(pid) else { return nil }
  guard !focusedTextTargetIsSecure(pid: pid) else { return nil }
  let element = focusedAccessibilityElement(pid: pid)
  guard let element else { return nil }
  guard elementMatchesExpected(element, expectedSignature: expectedElementSignature) else { return nil }

  // Strategy 1: Read full value, splice, set back (truly atomic, no cursor dance)
  var currentValue: CFTypeRef?
  let readErr = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &currentValue)
  if readErr == .success, let currentValue, let currentString = currentValue as? String {
    // Validate range bounds against actual text length
    let utf16View = currentString.utf16
    let textLen = utf16View.count
    if location >= 0 && location <= textLen && (location + length) <= textLen {
      // Splice the replacement in using UTF-16 indices
      let startIdx = utf16View.index(utf16View.startIndex, offsetBy: location)
      let endIdx = utf16View.index(startIdx, offsetBy: length)
      // Convert UTF-16 indices to String indices safely
      if let startStringIdx = String.Index(startIdx, within: currentString),
         let endStringIdx = String.Index(endIdx, within: currentString) {
        let before = String(currentString[currentString.startIndex..<startStringIdx])
        let after = String(currentString[endStringIdx..<currentString.endIndex])
        let newFullText = before + newText + after

        // Set the full value atomically
        let setErr = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, newFullText as CFTypeRef)
        if setErr == .success {
          var verifyFullValue: CFTypeRef?
          let verifyFullErr = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &verifyFullValue)
          guard verifyFullErr == .success,
                let verifiedString = verifyFullValue as? String,
                verifiedString == newFullText else {
            return nil
          }

          // Position cursor at end of inserted text
          let cursorPos = location + newText.utf16.count
          var cursorRange = CFRange(location: cursorPos, length: 0)
          if let rangeValue = AXValueCreate(.cfRange, &cursorRange) {
            let cursorErr = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, rangeValue)
            // Even if cursor positioning fails, the text was set correctly
            return [
              "method": "value",
              "cursorSet": cursorErr == .success,
              "cursorPosition": cursorPos,
              "textUtf16Length": newText.utf16.count,
            ]
          }
          return [
            "method": "value",
            "cursorSet": false,
            "cursorPosition": cursorPos,
            "textUtf16Length": newText.utf16.count,
          ]
        }
      }
      // kAXValueAttribute not settable or index conversion failed — fall through to strategy 2
    }
  }

  // Strategy 2: Set selection range, verify, then type over it
  guard pid != nil else { return nil }
  guard location >= 0, length >= 0 else { return nil }
  var range = CFRange(location: location, length: length)
  guard let rangeValue = AXValueCreate(.cfRange, &range) else { return nil }

  let setSelErr = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, rangeValue)
  guard setSelErr == .success else { return nil }

  // Verify the selection was actually set correctly
  _ = sleepMillis(5)
  var verifyValue: CFTypeRef?
  let verifyErr = AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &verifyValue)
  if verifyErr == .success, let verifyValue, CFGetTypeID(verifyValue) == AXValueGetTypeID() {
    var actualRange = CFRange(location: 0, length: 0)
    AXValueGetValue(verifyValue as! AXValue, .cfRange, &actualRange)
    // Allow slight mismatch (some apps normalize ranges) but location must match
    if actualRange.location != location || actualRange.length != length {
      // Selection verification failed — the AX state is unreliable
      return nil
    }
  } else {
    // Couldn't even read back the selection — bail
    return nil
  }

  // Selection verified, type the replacement
  guard frontmostMatchesPid(pid) else { return nil }
  _ = sleepMillis(5)
  guard focusedTextElementMatchesExpected(pid: pid, expectedSignature: expectedElementSignature) else { return nil }
  guard postUnicodeTextInChunks(newText, targetPid: pid, expectedElementSignature: expectedElementSignature) else { return nil }
  return [
    "method": "select_type",
    "cursorSet": true,
    "cursorPosition": location + newText.utf16.count,
    "textUtf16Length": newText.utf16.count,
  ]
}

/// Replace a text range by setting and verifying the AX selection, then typing
/// with keyboard events. This avoids kAXValueAttribute writes but still requires
/// an exact Accessibility range anchor.
func replaceTextRangeWithVerifiedSelection(
  location: Int,
  length: Int,
  newText: String,
  pid: pid_t? = nil,
  expectedElementSignature: String? = nil
) -> [String: Any]? {
  guard pid != nil else { return nil }
  guard frontmostMatchesPid(pid) else { return nil }
  guard !focusedTextTargetIsSecure(pid: pid) else { return nil }
  let element = focusedAccessibilityElement(pid: pid)
  guard location >= 0, length >= 0, let element else { return nil }
  guard elementMatchesExpected(element, expectedSignature: expectedElementSignature) else { return nil }

  var range = CFRange(location: location, length: length)
  guard let rangeValue = AXValueCreate(.cfRange, &range) else { return nil }

  let setSelErr = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, rangeValue)
  guard setSelErr == .success else { return nil }

  _ = sleepMillis(5)
  var verifyValue: CFTypeRef?
  let verifyErr = AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &verifyValue)
  guard verifyErr == .success,
        let verifyValue,
        CFGetTypeID(verifyValue) == AXValueGetTypeID() else {
    return nil
  }

  var actualRange = CFRange(location: 0, length: 0)
  guard AXValueGetValue(verifyValue as! AXValue, .cfRange, &actualRange),
        actualRange.location == location,
        actualRange.length == length else {
    return nil
  }

  _ = sleepMillis(5)
  guard frontmostMatchesPid(pid) else { return nil }
  guard focusedTextElementMatchesExpected(pid: pid, expectedSignature: expectedElementSignature) else { return nil }
  guard postUnicodeTextInChunks(newText, targetPid: pid, expectedElementSignature: expectedElementSignature) else { return nil }
  return [
    "method": "verified_select_type",
    "cursorSet": true,
    "cursorPosition": location + newText.utf16.count,
    "textUtf16Length": newText.utf16.count,
  ]
}

func typeCharacterByCharacter(_ text: String, delayMs: Int) {
  let pause = max(0, delayMs)
  for character in text {
    if character == "\n" || character == "\r" {
      postKeyboardEvent(keyCode: 36, keyDown: true)
      postKeyboardEvent(keyCode: 36, keyDown: false)
    } else if character == "\t" {
      postKeyboardEvent(keyCode: 48, keyDown: true)
      postKeyboardEvent(keyCode: 48, keyDown: false)
    } else {
      postUnicodeText(String(character))
    }
    _ = sleepMillis(pause)
  }
}

func modifierFlags(for key: String) -> CGEventFlags? {
  switch key.lowercased() {
  case "command", "cmd": return .maskCommand
  case "shift": return .maskShift
  case "option", "alt": return .maskAlternate
  case "control", "ctrl": return .maskControl
  default: return nil
  }
}

func keyCode(for key: String) -> CGKeyCode? {
  switch key.lowercased() {
  case "a": return 0
  case "s": return 1
  case "d": return 2
  case "f": return 3
  case "h": return 4
  case "g": return 5
  case "z": return 6
  case "x": return 7
  case "c": return 8
  case "v": return 9
  case "b": return 11
  case "q": return 12
  case "w": return 13
  case "e": return 14
  case "r": return 15
  case "y": return 16
  case "t": return 17
  case "1": return 18
  case "2": return 19
  case "3": return 20
  case "4": return 21
  case "6": return 22
  case "5": return 23
  case "=", "plus": return 24
  case "9": return 25
  case "7": return 26
  case "-", "minus": return 27
  case "8": return 28
  case "0": return 29
  case "]": return 30
  case "o": return 31
  case "u": return 32
  case "[": return 33
  case "i": return 34
  case "p": return 35
  case "enter", "return": return 36
  case "l": return 37
  case "j": return 38
  case "quote": return 39
  case "k": return 40
  case "semicolon": return 41
  case "backslash": return 42
  case "comma": return 43
  case "slash": return 44
  case "n": return 45
  case "m": return 46
  case "period": return 47
  case "tab": return 48
  case "space": return 49
  case "grave", "backtick": return 50
  case "delete", "backspace": return 51
  case "escape", "esc": return 53
  case "command", "cmd": return 55
  case "shift": return 56
  case "capslock": return 57
  case "option", "alt": return 58
  case "control", "ctrl": return 59
  case "rightshift": return 60
  case "rightoption": return 61
  case "rightcontrol": return 62
  case "function", "fn": return 63
  case "home": return 115
  case "pageup": return 116
  case "forwarddelete": return 117
  case "end": return 119
  case "pagedown": return 121
  case "left": return 123
  case "right": return 124
  case "down": return 125
  case "up": return 126
  default: return nil
  }
}

func pressKeyCombo(_ keys: [String], delayMs: Int) {
  let lowered = keys.map { $0.lowercased() }
  let modifiers = lowered.dropLast().compactMap(modifierFlags)
  let flags = modifiers.reduce(CGEventFlags()) { partial, flag in
    partial.union(flag)
  }
  let primary = lowered.last ?? "enter"

  if let code = keyCode(for: primary) {
    postKeyboardEvent(keyCode: code, keyDown: true, flags: flags)
    _ = sleepMillis(max(12, delayMs / 2))
    postKeyboardEvent(keyCode: code, keyDown: false, flags: flags)
    return
  }

  if primary.count == 1 {
    postUnicodeText(primary, flags: flags)
  }
}

func decodeBase64String(_ value: String) -> String? {
  guard let data = Data(base64Encoded: value) else {
    return nil
  }
  return String(data: data, encoding: .utf8)
}

func eventTypeName(_ type: CGEventType) -> String {
  switch type {
  case .leftMouseDown: return "leftMouseDown"
  case .leftMouseUp: return "leftMouseUp"
  case .rightMouseDown: return "rightMouseDown"
  case .rightMouseUp: return "rightMouseUp"
  case .mouseMoved: return "mouseMoved"
  case .leftMouseDragged: return "leftMouseDragged"
  case .rightMouseDragged: return "rightMouseDragged"
  case .scrollWheel: return "scrollWheel"
  case .keyDown: return "keyDown"
  case .keyUp: return "keyUp"
  case .flagsChanged: return "flagsChanged"
  default: return "other"
  }
}

func eventKind(_ type: CGEventType) -> String {
  switch type {
  case .keyDown, .keyUp, .flagsChanged:
    return "keyboard"
  case .mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .leftMouseDragged, .rightMouseDragged, .scrollWheel:
    return "mouse"
  default:
    return "other"
  }
}

func nowMillis() -> Int {
  Int(Date().timeIntervalSince1970 * 1000)
}

func characterPrefixLength(_ lhs: String, _ rhs: String) -> Int {
  var count = 0
  var lhsIndex = lhs.startIndex
  var rhsIndex = rhs.startIndex
  while lhsIndex < lhs.endIndex && rhsIndex < rhs.endIndex {
    if lhs[lhsIndex] != rhs[rhsIndex] { break }
    count += 1
    lhsIndex = lhs.index(after: lhsIndex)
    rhsIndex = rhs.index(after: rhsIndex)
  }
  return count
}

func characterSuffix(_ text: String, droppingFirst count: Int) -> String {
  if count <= 0 { return text }
  if count >= text.count { return "" }
  return String(text[text.index(text.startIndex, offsetBy: count)..<text.endIndex])
}

final class DictationSessionServer {
  private let mainRunLoop: CFRunLoop
  private let outputLock = NSLock()
  private var targetPid: pid_t?
  private var targetName = ""
  private var targetBundleId: String?
  private var targetCapturedAt = 0
  private var axLocation: Int?
  private var axTypedUtf16Length = 0
  private var axElementSignature: String?
  private var axSuppressed = false
  private var partialText = ""
  private var partialTypingModeUsed: String?
  private var partialTypingStrategyUsed: String?
  private var partialTyping: [String: String] = [:]
  private var livePartials = false
  private var allowBlindKeyboardFullPatch = false
  private var ownPid: pid_t?
  private var ownAppName = ""
  private var monitorTap: CFMachPort?
  private var monitorSource: CFRunLoopSource?

  init() {
    self.mainRunLoop = CFRunLoopGetCurrent()
  }

  func run() {
    emit(["event": "ready", "protocolVersion": 1])
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      while let line = readLine() {
        self?.handleLine(line)
      }
      if let runLoop = self?.mainRunLoop {
        CFRunLoopStop(runLoop)
      }
    }
    CFRunLoopRun()
    stopTargetTracking()
  }

  private func emit(_ payload: [String: Any]) {
    outputLock.lock()
    printJson(payload)
    outputLock.unlock()
  }

  private func respond(_ id: String, _ payload: [String: Any]) {
    var response = payload
    response["id"] = id
    emit(response)
  }

  private func handleLine(_ line: String) {
    guard let data = line.data(using: .utf8),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let id = raw["id"] as? String,
          let method = raw["method"] as? String else {
      emit(["ok": false, "event": "protocol-error", "error": "Invalid request"])
      return
    }
    let params = raw["params"] as? [String: Any] ?? [:]

    switch method {
    case "beginSession":
      respond(id, beginSession(params))
    case "startTargetTracking":
      respond(id, startTargetTracking())
    case "stopTargetTracking":
      stopTargetTracking()
      respond(id, sessionResponse(["ok": true]))
    case "refreshTarget":
      respond(id, refreshTarget())
    case "applyPartial":
      respond(id, applyPartial(params))
    case "applyFinal":
      respond(id, applyFinal(params))
    case "endSession":
      stopTargetTracking()
      respond(id, sessionResponse(["ok": true]))
      CFRunLoopStop(mainRunLoop)
    default:
      respond(id, ["ok": false, "error": "Unknown method: \(method)", "errorCode": "unknown_method"])
    }
  }

  private func sessionResponse(_ extra: [String: Any] = [:]) -> [String: Any] {
    var response: [String: Any] = [
      "ok": true,
      "typingMode": typingMode(),
      "capturedAx": hasAxSpan,
      "partialText": partialText,
      "capturedAt": targetCapturedAt,
    ]
    if let targetPid {
      response["targetPid"] = Int(targetPid)
    }
    if !targetName.isEmpty {
      response["targetName"] = targetName
    }
    if let targetBundleId {
      response["targetBundleId"] = targetBundleId
    }
    if let partialTypingStrategyUsed {
      response["strategy"] = partialTypingStrategyUsed
    }
    for (key, value) in extra {
      response[key] = value
    }
    return response
  }

  private var hasAxSpan: Bool {
    axLocation != nil && axElementSignature != nil && !axSuppressed
  }

  private func configuredStrategy(_ mode: String) -> String {
    if let strategy = partialTyping[mode] {
      return normalizeStrategy(mode, strategy)
    }
    if livePartials {
      return mode == "ax" ? "full-replacement" : "disabled"
    }
    return "disabled"
  }

  private func normalizeStrategy(_ mode: String, _ strategy: String) -> String {
    if mode == "ax" {
      return ["disabled", "full-replacement", "ax-verified"].contains(strategy)
        ? strategy
        : "full-replacement"
    }
    return ["disabled", "ax-verified", "tail-only", "full-patch"].contains(strategy)
      ? strategy
      : "ax-verified"
  }

  private func hasEnabledPartialStrategy() -> Bool {
    configuredStrategy("ax") != "disabled" || configuredStrategy("kb") != "disabled"
  }

  private func typingMode() -> String {
    if hasAxSpan && configuredStrategy("ax") != "disabled" {
      return "ax"
    }
    if configuredStrategy("kb") != "disabled" || (!hasAxSpan && allowBlindKeyboardFullPatch) {
      return "kb"
    }
    if hasAxSpan {
      return "ax"
    }
    return "idle"
  }

  private func partialMode() -> String {
    if hasAxSpan && configuredStrategy("ax") != "disabled" {
      return "ax"
    }
    if configuredStrategy("kb") != "disabled" {
      return "kb"
    }
    return hasAxSpan ? "ax" : "kb"
  }

  private func beginSession(_ params: [String: Any]) -> [String: Any] {
    partialTyping.removeAll()
    if let rawPartialTyping = params["partialTyping"] as? [String: Any] {
      if let ax = rawPartialTyping["ax"] as? String {
        partialTyping["ax"] = normalizeStrategy("ax", ax)
      }
      if let kb = rawPartialTyping["kb"] as? String {
        partialTyping["kb"] = normalizeStrategy("kb", kb)
      }
    }
    livePartials = (params["livePartials"] as? Bool) ?? false
    allowBlindKeyboardFullPatch = (params["allowBlindKeyboardFullPatch"] as? Bool) ?? false
    if let rawPid = params["ownPid"] as? Int {
      ownPid = pid_t(rawPid)
    } else if let rawPid = params["ownPid"] as? NSNumber {
      ownPid = pid_t(rawPid.intValue)
    } else {
      ownPid = nil
    }
    ownAppName = params["ownAppName"] as? String ?? ""
    partialText = ""
    partialTypingModeUsed = nil
    partialTypingStrategyUsed = nil
    axSuppressed = false
    clearAxSpan()

    guard AXIsProcessTrusted() else {
      return ["ok": false, "error": "Dictation requires macOS Accessibility permission before it can type safely.", "errorCode": "accessibility"]
    }
    guard captureFrontmostTarget() else {
      return ["ok": false, "error": "Dictation could not identify the target app. Click into the field and try again.", "errorCode": "target_app"]
    }

    let capture = captureAxSpan()
    if capture.errorCode == "secure_field" {
      return ["ok": false, "error": "Dictation will not type into secure text fields.", "errorCode": "secure_field"]
    }
    if !capture.ok && !allowBlindKeyboardFullPatch {
      return ["ok": false, "error": "Dictation could not verify the target text cursor or selection. Click into a standard text field and try again.", "errorCode": "cursor_unverified"]
    }

    return sessionResponse(["ok": true, "applied": false])
  }

  private func captureFrontmostTarget() -> Bool {
    guard let info = frontmostApplicationInfo() else { return false }
    let pid: pid_t?
    if let rawPid = info["pid"] as? pid_t {
      pid = rawPid
    } else if let rawPid = info["pid"] as? Int {
      pid = pid_t(rawPid)
    } else if let rawPid = info["pid"] as? NSNumber {
      pid = pid_t(rawPid.intValue)
    } else {
      pid = nil
    }
    let appName = info["name"] as? String ?? ""
    if let pid, let ownPid, pid == ownPid {
      return false
    }
    if !ownAppName.isEmpty && appName.lowercased() == ownAppName.lowercased() {
      return false
    }
    guard let pid else { return false }
    targetPid = pid
    targetName = appName
    targetBundleId = info["bundleId"] as? String
    targetCapturedAt = nowMillis()
    return true
  }

  private func captureAxSpan() -> (ok: Bool, errorCode: String?) {
    guard let targetPid else {
      clearAxSpan()
      return (false, "target_app")
    }
    guard frontmostMatchesPid(targetPid) else {
      clearAxSpan()
      return (false, "target_changed")
    }
    guard !focusedTextTargetIsSecure(pid: targetPid) else {
      clearAxSpan()
      return (false, "secure_field")
    }
    guard let signature = focusedTextElementSignature(pid: targetPid),
          let range = focusedSelectedTextRange(pid: targetPid) else {
      clearAxSpan()
      return (false, "cursor_unverified")
    }
    axLocation = range.location
    axTypedUtf16Length = range.length
    axElementSignature = signature
    axSuppressed = false
    return (true, nil)
  }

  private func clearAxSpan() {
    axLocation = nil
    axTypedUtf16Length = 0
    axElementSignature = nil
  }

  private func refreshTarget() -> [String: Any] {
    if !partialText.isEmpty || partialTypingModeUsed != nil || partialTypingStrategyUsed != nil {
      return sessionResponse(["ok": true, "applied": false, "skipped": "typing-started"])
    }
    guard captureFrontmostTarget() else {
      clearAxSpan()
      return ["ok": false, "error": "Dictation could not identify the target app.", "errorCode": "target_app"]
    }
    let capture = captureAxSpan()
    if capture.errorCode == "secure_field" {
      return ["ok": false, "error": "Dictation will not type into secure text fields.", "errorCode": "secure_field"]
    }
    return sessionResponse(["ok": true, "applied": false])
  }

  private func applyPartial(_ params: [String: Any]) -> [String: Any] {
    guard let text = params["text"] as? String else {
      return ["ok": false, "error": "Missing partial text", "errorCode": "invalid_request"]
    }
    guard hasEnabledPartialStrategy() else {
      return sessionResponse(["ok": true, "applied": false])
    }
    let mode = partialMode()
    let strategy = configuredStrategy(mode)
    guard strategy != "disabled" else {
      return sessionResponse(["ok": true, "applied": false])
    }
    let applied = applyStrategy(mode: mode, strategy: strategy, currentText: partialText, targetText: text, phase: "partial")
    if applied {
      partialText = text
      partialTypingModeUsed = mode
      partialTypingStrategyUsed = strategy
      return sessionResponse(["ok": true, "applied": true])
    }
    return sessionResponse(["ok": true, "applied": false, "errorCode": "mutation_failed"])
  }

  private func applyFinal(_ params: [String: Any]) -> [String: Any] {
    guard let text = params["text"] as? String else {
      return ["ok": false, "error": "Missing final text", "errorCode": "invalid_request"]
    }
    let mode: String
    let strategy: String
    if !partialText.isEmpty, let usedMode = partialTypingModeUsed, let usedStrategy = partialTypingStrategyUsed {
      mode = usedMode
      strategy = usedStrategy
    } else if hasAxSpan {
      mode = "ax"
      strategy = "full-replacement"
    } else if allowBlindKeyboardFullPatch {
      mode = "kb"
      strategy = "full-patch"
    } else {
      return ["ok": false, "error": "Dictation could not safely type the final transcript because the target app, cursor, or selection could not be verified.", "errorCode": "mutation_failed"]
    }

    let applied = applyStrategy(mode: mode, strategy: strategy, currentText: partialText, targetText: text, phase: "final")
    guard applied else {
      return ["ok": false, "error": "Dictation could not safely type the final transcript because the target app, cursor, or selection could not be verified.", "errorCode": "mutation_failed"]
    }

    partialText = ""
    partialTypingModeUsed = nil
    partialTypingStrategyUsed = nil
    clearAxSpan()
    axSuppressed = false
    return sessionResponse(["ok": true, "applied": true])
  }

  private func applyStrategy(
    mode: String,
    strategy: String,
    currentText: String,
    targetText: String,
    phase: String
  ) -> Bool {
    if currentText == targetText { return true }
    if mode == "ax" {
      guard let location = axLocation,
            let signature = axElementSignature,
            let pid = targetPid else { return false }
      let length = axTypedUtf16Length
      let result: [String: Any]?
      if strategy == "ax-verified" {
        result = replaceTextRangeWithVerifiedSelection(
          location: location,
          length: length,
          newText: targetText,
          pid: pid,
          expectedElementSignature: signature
        )
      } else {
        result = replaceTextRangeAtomically(
          location: location,
          length: length,
          newText: targetText,
          pid: pid,
          expectedElementSignature: signature
        )
      }
      guard let result else {
        axSuppressed = phase == "partial"
        return false
      }
      axTypedUtf16Length = (result["textUtf16Length"] as? Int) ?? targetText.utf16.count
      _ = refreshAxSignatureAfterMutation()
      return true
    }

    if strategy == "ax-verified", hasAxSpan {
      guard let location = axLocation,
            let signature = axElementSignature,
            let pid = targetPid,
            let result = replaceTextRangeWithVerifiedSelection(
              location: location,
              length: axTypedUtf16Length,
              newText: targetText,
              pid: pid,
              expectedElementSignature: signature
            ) else {
        return false
      }
      axTypedUtf16Length = (result["textUtf16Length"] as? Int) ?? targetText.utf16.count
      _ = refreshAxSignatureAfterMutation()
      return true
    }

    if strategy == "tail-only" {
      guard targetText.hasPrefix(currentText) else { return false }
      return postTextForKeyboardMutation(characterSuffix(targetText, droppingFirst: currentText.count))
    }

    return applyKeyboardPatch(currentText: currentText, targetText: targetText)
  }

  private func refreshAxSignatureAfterMutation() -> Bool {
    guard let location = axLocation,
          let pid = targetPid,
          let range = focusedSelectedTextRange(pid: pid),
          range.location == location + axTypedUtf16Length,
          range.length == 0,
          let signature = focusedTextElementSignature(pid: pid) else {
      return false
    }
    axElementSignature = signature
    return true
  }

  private func postTextForKeyboardMutation(_ text: String) -> Bool {
    if text.isEmpty { return true }
    let allowUnverified = !hasAxSpan && allowBlindKeyboardFullPatch
    let expectedSignature = allowUnverified ? nil : axElementSignature
    guard let targetPid else { return false }
    guard frontmostMatchesPid(targetPid) else { return false }
    guard !focusedTextTargetIsSecure(pid: targetPid) else { return false }
    if !allowUnverified {
      guard focusedTextElementMatchesExpected(pid: targetPid, expectedSignature: expectedSignature) else {
        return false
      }
    }
    return postUnicodeTextInChunks(
      text,
      chunkSize: allowUnverified ? blindKeyboardTextChunkSize : 16,
      targetPid: targetPid,
      expectedElementSignature: expectedSignature
    )
  }

  private func deleteBackForKeyboardMutation(_ count: Int) -> Bool {
    if count <= 0 { return true }
    if count > maxKeyboardRepeatCount { return false }
    let allowUnverified = !hasAxSpan && allowBlindKeyboardFullPatch
    let expectedSignature = allowUnverified ? nil : axElementSignature
    guard let targetPid else { return false }
    guard frontmostMatchesPid(targetPid) else { return false }
    guard !focusedTextTargetIsSecure(pid: targetPid) else { return false }
    if !allowUnverified {
      guard focusedTextElementMatchesExpected(pid: targetPid, expectedSignature: expectedSignature) else {
        return false
      }
    }
    return pressKeyRepeated(
      keyCode: 51,
      count: count,
      delayMs: 3,
      targetPid: targetPid,
      expectedElementSignature: expectedSignature
    )
  }

  private func applyKeyboardPatch(currentText: String, targetText: String) -> Bool {
    if currentText == targetText { return true }
    let commonLength = characterPrefixLength(currentText, targetText)
    let deleteCount = currentText.count - commonLength
    let insertText = characterSuffix(targetText, droppingFirst: commonLength)
    guard deleteBackForKeyboardMutation(deleteCount) else { return false }
    return postTextForKeyboardMutation(insertText)
  }

  private func startTargetTracking() -> [String: Any] {
    if monitorTap != nil {
      return sessionResponse(["ok": true])
    }
    let monitoredEventTypes: [CGEventType] = [
      .mouseMoved,
      .leftMouseDown,
      .leftMouseUp,
      .rightMouseDown,
      .rightMouseUp,
      .leftMouseDragged,
      .rightMouseDragged,
      .scrollWheel,
      .keyDown,
      .keyUp,
      .flagsChanged,
    ]
    let mask = monitoredEventTypes.reduce(CGEventMask(0)) { partialResult, eventType in
      partialResult | (CGEventMask(1) << Int(eventType.rawValue))
    }
    let userInfo = Unmanaged.passUnretained(self).toOpaque()
    guard let tap = CGEvent.tapCreate(
      tap: .cgSessionEventTap,
      place: .headInsertEventTap,
      options: .listenOnly,
      eventsOfInterest: CGEventMask(mask),
      callback: { _, type, event, refcon in
        guard let refcon else { return Unmanaged.passUnretained(event) }
        let server = Unmanaged<DictationSessionServer>.fromOpaque(refcon).takeUnretainedValue()
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
          server.emit([
            "event": "monitor-disabled",
            "reason": type == .tapDisabledByTimeout ? "timeout" : "user-input",
          ])
          return Unmanaged.passUnretained(event)
        }

        let sourcePid = event.getIntegerValueField(.eventSourceUnixProcessID)
        let sourceTag = event.getIntegerValueField(.eventSourceUserData)
        if sourcePid == Int64(getpid()) || sourceTag == syntheticEventTag {
          return Unmanaged.passUnretained(event)
        }

        var payload: [String: Any] = [
          "event": "targetDirty",
          "reason": "\(eventKind(type)):\(eventTypeName(type))",
          "kind": eventKind(type),
          "eventType": eventTypeName(type),
        ]
        if type == .keyDown || type == .keyUp || type == .flagsChanged {
          payload["keyCode"] = event.getIntegerValueField(.keyboardEventKeycode)
        }
        server.emit(payload)
        return Unmanaged.passUnretained(event)
      },
      userInfo: userInfo
    ) else {
      return ["ok": false, "error": "Unable to start dictation target monitor.", "errorCode": "input_monitoring"]
    }

    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(mainRunLoop, source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    monitorTap = tap
    monitorSource = source
    return sessionResponse(["ok": true])
  }

  private func stopTargetTracking() {
    if let monitorTap {
      CGEvent.tapEnable(tap: monitorTap, enable: false)
    }
    if let monitorSource {
      CFRunLoopRemoveSource(mainRunLoop, monitorSource, .commonModes)
    }
    monitorTap = nil
    monitorSource = nil
  }
}

let args = CommandLine.arguments
guard args.count >= 2 else {
  printJson(["ok": false, "error": "Missing command"])
  exit(1)
}

switch args[1] {
case "dictationSession":
  let server = DictationSessionServer()
  server.run()

case "frontmostApplication":
  guard let info = frontmostApplicationInfo() else {
    printJson(["ok": false, "error": "Unable to identify frontmost application"])
    exit(1)
  }
  printJson(info)

case "permissions":
  let result: [String: Any] = [
    "ok": true,
    "accessibilityTrusted": AXIsProcessTrusted(),
    "screenRecordingGranted": CGPreflightScreenCaptureAccess(),
    "automationGranted": true,
    "desktopCoordinateWidth": desktopCoordinateWidth(),
    "desktopCoordinateHeight": desktopCoordinateHeight(),
    "desktopWidth": desktopPixelWidth(),
    "desktopHeight": desktopPixelHeight(),
  ]
  printJson(result)

case "requestScreenRecording":
  var granted = CGPreflightScreenCaptureAccess()
  if !granted {
    granted = CGRequestScreenCaptureAccess()
  }
  printJson([
    "ok": true,
    "screenRecordingGranted": granted,
    "desktopCoordinateWidth": desktopCoordinateWidth(),
    "desktopCoordinateHeight": desktopCoordinateHeight(),
    "desktopWidth": desktopPixelWidth(),
    "desktopHeight": desktopPixelHeight(),
  ])

case "move":
  guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else {
    printJson(["ok": false, "error": "Expected x y [durationMs] [steps] [movementPath]"])
    exit(1)
  }
  let durationMs = parseIntArg(args, 4, default: 140)
  let steps = parseIntArg(args, 5, default: 14)
  let movementPath = parseMovementPathArg(args, 6)
  let start = currentPointerTopLeft()
  animatePointerMove(from: start, to: CGPoint(x: x, y: y), durationMs: durationMs, steps: steps, path: movementPath)
  printJson(["ok": true])

case "drag":
  guard args.count >= 6,
        let startX = Double(args[2]),
        let startY = Double(args[3]),
        let endX = Double(args[4]),
        let endY = Double(args[5]) else {
    printJson(["ok": false, "error": "Expected startX startY endX endY [durationMs] [steps] [movementPath]"])
    exit(1)
  }
  let durationMs = parseIntArg(args, 6, default: 260)
  let steps = parseIntArg(args, 7, default: 24)
  let movementPath = parseMovementPathArg(args, 8)
  dragPointer(from: CGPoint(x: startX, y: startY), to: CGPoint(x: endX, y: endY), durationMs: durationMs, steps: steps, path: movementPath)
  printJson(["ok": true])

case "click":
  guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else {
    printJson(["ok": false, "error": "Expected x y [durationMs] [movementPath]"])
    exit(1)
  }
  let durationMs = parseIntArg(args, 4, default: 110)
  let movementPath = parseMovementPathArg(args, 5)
  let start = currentPointerTopLeft()
  animatePointerMove(from: start, to: CGPoint(x: x, y: y), durationMs: durationMs, steps: 10, path: movementPath)
  postMouse(.leftMouseDown, x: x, y: y)
  postMouse(.leftMouseUp, x: x, y: y)
  printJson(["ok": true])

case "doubleClick":
  guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else {
    printJson(["ok": false, "error": "Expected x y [durationMs] [movementPath]"])
    exit(1)
  }
  let durationMs = parseIntArg(args, 4, default: 120)
  let movementPath = parseMovementPathArg(args, 5)
  let start = currentPointerTopLeft()
  animatePointerMove(from: start, to: CGPoint(x: x, y: y), durationMs: durationMs, steps: 12, path: movementPath)
  postMouse(.leftMouseDown, x: x, y: y, clickState: 1)
  postMouse(.leftMouseUp, x: x, y: y, clickState: 1)
  _ = sleepMillis(55)
  postMouse(.leftMouseDown, x: x, y: y, clickState: 2)
  postMouse(.leftMouseUp, x: x, y: y, clickState: 2)
  printJson(["ok": true])

case "scroll":
  guard args.count >= 4, let dx = Int32(args[2]), let dy = Int32(args[3]) else {
    printJson(["ok": false, "error": "Expected dx dy"])
    exit(1)
  }
  let event = CGEvent(scrollWheelEvent2Source: syntheticSource, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
  event?.setIntegerValueField(.eventSourceUserData, value: syntheticEventTag)
  event?.post(tap: .cghidEventTap)
  printJson(["ok": true])

case "typeText":
  guard args.count >= 3 else {
    printJson(["ok": false, "error": "Expected base64Text [delayMs]"])
    exit(1)
  }
  guard let decoded = decodeBase64String(args[2]) else {
    printJson(["ok": false, "error": "Invalid base64 text"])
    exit(1)
  }
  let delayMs = parseIntArg(args, 3, default: 45)
  typeCharacterByCharacter(decoded, delayMs: delayMs)
  printJson(["ok": true])

case "postText":
  // Bulk text insertion via CGEvent.keyboardSetUnicodeString in chunks.
  // Faster than typeCharacterByCharacter — no per-char delay.
  // Used by dictation for instant text output.
  guard args.count >= 3 else {
    printJson(["ok": false, "error": "Expected base64Text"])
    exit(1)
  }
  guard let decoded = decodeBase64String(args[2]) else {
    printJson(["ok": false, "error": "Invalid base64 text"])
    exit(1)
  }
  let ptTargetPid: pid_t? = args.count >= 4 ? pid_t(args[3]) : nil
  let ptAllowUnverified = allowsUnverifiedKeyboardTarget(args)
  guard frontmostMatchesPid(ptTargetPid) else {
    printJson(["ok": false, "error": "Frontmost application no longer matches dictation target"])
    exit(1)
  }
  let ptExpectedSignature = expectedElementSignatureArg(args, 4)
  guard !focusedTextTargetIsSecure(pid: ptTargetPid) else {
    printJson(["ok": false, "error": "Refusing to type into secure text field"])
    exit(1)
  }
  if !ptAllowUnverified {
    guard focusedTextElementMatchesExpected(pid: ptTargetPid, expectedSignature: ptExpectedSignature) else {
      printJson(["ok": false, "error": "Focused text element no longer matches dictation target"])
      exit(1)
    }
  }
  guard postUnicodeTextInChunks(
    decoded,
    chunkSize: ptAllowUnverified ? blindKeyboardTextChunkSize : 16,
    targetPid: ptTargetPid,
    expectedElementSignature: ptExpectedSignature
  ) else {
    printJson(["ok": false, "error": "Frontmost application changed while typing"])
    exit(1)
  }
  printJson(["ok": true])

case "focusedTextSelection":
  // Optional PID argument: focusedTextSelection [pid]
  let ftsTargetPid: pid_t? = args.count >= 3 ? pid_t(args[2]) : nil
  guard frontmostMatchesPid(ftsTargetPid) else {
    printJson(["ok": false, "error": "Frontmost application no longer matches dictation target"])
    exit(1)
  }
  guard !focusedTextTargetIsSecure(pid: ftsTargetPid) else {
    printJson(["ok": false, "error": "Focused target is a secure text field"])
    exit(1)
  }
  guard let ftsElementSignature = focusedTextElementSignature(pid: ftsTargetPid) else {
    printJson(["ok": false, "error": "Unable to identify focused text element"])
    exit(1)
  }
  guard let range = focusedSelectedTextRange(pid: ftsTargetPid) else {
    printJson(["ok": false, "error": "Unable to read focused selected text range"])
    exit(1)
  }
  printJson([
    "ok": true,
    "selectedTextRangeLocation": range.location,
    "selectedTextRangeLength": range.length,
    "elementSignature": ftsElementSignature,
  ])

case "focusedTextRangeState":
  // Args: focusedTextRangeState location length [pid]
  guard args.count >= 4,
        let location = Int(args[2]),
        let length = Int(args[3]) else {
    printJson(["ok": false, "error": "Expected location length [pid]"])
    exit(1)
  }
  let ftrsTargetPid: pid_t? = args.count >= 5 ? pid_t(args[4]) : nil
  guard frontmostMatchesPid(ftrsTargetPid) else {
    printJson(["ok": false, "error": "Frontmost application no longer matches dictation target"])
    exit(1)
  }
  guard !focusedTextTargetIsSecure(pid: ftrsTargetPid) else {
    printJson(["ok": false, "error": "Focused target is a secure text field"])
    exit(1)
  }
  guard let ftrsElementSignature = focusedTextElementSignature(pid: ftrsTargetPid) else {
    printJson(["ok": false, "error": "Unable to identify focused text element"])
    exit(1)
  }
  guard let range = focusedSelectedTextRange(pid: ftrsTargetPid) else {
    printJson(["ok": false, "error": "Unable to read focused selected text range"])
    exit(1)
  }
  guard let value = focusedTextValue(pid: ftrsTargetPid),
        let rangeText = utf16Slice(value, location: location, length: length) else {
    printJson(["ok": false, "error": "Unable to read focused text range"])
    exit(1)
  }
  printJson([
    "ok": true,
    "selectedTextRangeLocation": range.location,
    "selectedTextRangeLength": range.length,
    "elementSignature": ftrsElementSignature,
    "rangeText": rangeText,
    "textUtf16Length": value.utf16.count,
  ])

case "replaceFocusedTextRange":
  // Set the focused text element selection with Accessibility, then type text
  // over that selection. This avoids visible left/right cursor scans.
  // Args: replaceFocusedTextRange location length base64Text [pid]
  guard args.count >= 5,
        let location = Int(args[2]),
        let length = Int(args[3]) else {
    printJson(["ok": false, "error": "Expected location length base64Text"])
    exit(1)
  }
  guard let decoded = decodeBase64String(args[4]) else {
    printJson(["ok": false, "error": "Invalid base64 text"])
    exit(1)
  }
  let rftTargetPid: pid_t? = args.count >= 6 ? pid_t(args[5]) : nil
  guard !focusedTextTargetIsSecure(pid: rftTargetPid) else {
    printJson(["ok": false, "error": "Refusing to type into secure text field"])
    exit(1)
  }
  guard frontmostMatchesPid(rftTargetPid) else {
    printJson(["ok": false, "error": "Frontmost application no longer matches dictation target"])
    exit(1)
  }
  let rftExpectedSignature = expectedElementSignatureArg(args, 6)
  guard focusedTextElementMatchesExpected(pid: rftTargetPid, expectedSignature: rftExpectedSignature) else {
    printJson(["ok": false, "error": "Focused text element no longer matches dictation target"])
    exit(1)
  }
  guard setFocusedSelectedTextRange(location: location, length: length, pid: rftTargetPid) else {
    printJson(["ok": false, "error": "Unable to set focused selected text range"])
    exit(1)
  }
  _ = sleepMillis(8)
  guard postUnicodeTextInChunks(decoded, targetPid: rftTargetPid, expectedElementSignature: rftExpectedSignature) else {
    printJson(["ok": false, "error": "Frontmost application changed while typing"])
    exit(1)
  }
  printJson(["ok": true])

case "replaceTextAtomically":
  // Atomic text replacement: tries kAXValueAttribute first (full-text splice),
  // then falls back to verified select+type. More reliable than replaceFocusedTextRange.
  // Args: replaceTextAtomically location length base64Text [pid]
  guard args.count >= 5,
        let location = Int(args[2]),
        let length = Int(args[3]) else {
    printJson(["ok": false, "error": "Expected location length base64Text"])
    exit(1)
  }
  guard let decoded = decodeBase64String(args[4]) else {
    printJson(["ok": false, "error": "Invalid base64 text"])
    exit(1)
  }
  let ratTargetPid: pid_t? = args.count >= 6 ? pid_t(args[5]) : nil
  let ratExpectedSignature = expectedElementSignatureArg(args, 6)
  guard let result = replaceTextRangeAtomically(
    location: location,
    length: length,
    newText: decoded,
    pid: ratTargetPid,
    expectedElementSignature: ratExpectedSignature
  ) else {
    printJson(["ok": false, "error": "Both value-set and verified select-type failed"])
    exit(1)
  }
  var response: [String: Any] = ["ok": true]
  for (key, value) in result {
    response[key] = value
  }
  printJson(response)

case "replaceTextRangeVerified":
  // AX-verified keyboard replacement: set selected range, verify it, then type.
  // Args: replaceTextRangeVerified location length base64Text [pid]
  guard args.count >= 5,
        let location = Int(args[2]),
        let length = Int(args[3]) else {
    printJson(["ok": false, "error": "Expected location length base64Text"])
    exit(1)
  }
  guard let decoded = decodeBase64String(args[4]) else {
    printJson(["ok": false, "error": "Invalid base64 text"])
    exit(1)
  }
  let rtvTargetPid: pid_t? = args.count >= 6 ? pid_t(args[5]) : nil
  let rtvExpectedSignature = expectedElementSignatureArg(args, 6)
  guard let result = replaceTextRangeWithVerifiedSelection(
    location: location,
    length: length,
    newText: decoded,
    pid: rtvTargetPid,
    expectedElementSignature: rtvExpectedSignature
  ) else {
    printJson(["ok": false, "error": "Unable to set and verify focused selected text range"])
    exit(1)
  }
  var verifiedResponse: [String: Any] = ["ok": true]
  for (key, value) in result {
    verifiedResponse[key] = value
  }
  printJson(verifiedResponse)

case "deleteBack":
  // Delete N characters backwards (backspace key).
  // Used by dictation to erase partial text before retyping corrected final.
  guard args.count >= 3 else {
    printJson(["ok": false, "error": "Expected count"])
    exit(1)
  }
  guard let deleteCount = Int(args[2]),
        deleteCount >= 0,
        deleteCount <= maxKeyboardRepeatCount else {
    printJson(["ok": false, "error": "Invalid or excessive delete count"])
    exit(1)
  }
  let dbTargetPid: pid_t? = args.count >= 4 ? pid_t(args[3]) : nil
  let dbAllowUnverified = allowsUnverifiedKeyboardTarget(args)
  guard frontmostMatchesPid(dbTargetPid) else {
    printJson(["ok": false, "error": "Frontmost application no longer matches dictation target"])
    exit(1)
  }
  let dbExpectedSignature = expectedElementSignatureArg(args, 4)
  guard !focusedTextTargetIsSecure(pid: dbTargetPid) else {
    printJson(["ok": false, "error": "Refusing to delete in secure text field"])
    exit(1)
  }
  if !dbAllowUnverified {
    guard focusedTextElementMatchesExpected(pid: dbTargetPid, expectedSignature: dbExpectedSignature) else {
      printJson(["ok": false, "error": "Focused text element no longer matches dictation target"])
      exit(1)
    }
  }
  guard pressKeyRepeated(keyCode: 51, count: deleteCount, delayMs: 3, targetPid: dbTargetPid, expectedElementSignature: dbExpectedSignature) else {
    printJson(["ok": false, "error": "Frontmost application changed while deleting"])
    exit(1)
  }
  printJson(["ok": true])

case "applyTextPatch":
  // Batched cursor/text operations for dictation correction patches.
  // Keeps small rewrites in one helper invocation so apps do not visibly blank
  // and then refill the whole line for punctuation or capitalization changes.
  guard args.count >= 3 else {
    printJson(["ok": false, "error": "Expected base64 JSON operations"])
    exit(1)
  }
  guard let decoded = decodeBase64String(args[2]),
        let data = decoded.data(using: .utf8),
        let operations = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
    printJson(["ok": false, "error": "Invalid patch operations"])
    exit(1)
  }
  let atpTargetPid: pid_t? = args.count >= 4 ? pid_t(args[3]) : nil
  let atpAllowUnverified = allowsUnverifiedKeyboardTarget(args)
  guard frontmostMatchesPid(atpTargetPid) else {
    printJson(["ok": false, "error": "Frontmost application no longer matches dictation target"])
    exit(1)
  }
  let atpExpectedSignature = expectedElementSignatureArg(args, 4)
  guard !focusedTextTargetIsSecure(pid: atpTargetPid) else {
    printJson(["ok": false, "error": "Refusing to patch secure text field"])
    exit(1)
  }
  if !atpAllowUnverified {
    guard focusedTextElementMatchesExpected(pid: atpTargetPid, expectedSignature: atpExpectedSignature) else {
      printJson(["ok": false, "error": "Focused text element no longer matches dictation target"])
      exit(1)
    }
  }
  if let validationError = validatePatchOperations(operations) {
    printJson(["ok": false, "error": validationError])
    exit(1)
  }

  for operation in operations {
    guard let kind = operation["kind"] as? String else {
      printJson(["ok": false, "error": "Patch operation missing kind"])
      exit(1)
    }

    switch kind {
    case "moveLeft":
      guard let count = operationCount(operation) else {
        printJson(["ok": false, "error": "moveLeft missing count"])
        exit(1)
      }
      guard pressKeyRepeated(keyCode: 123, count: count, targetPid: atpTargetPid, expectedElementSignature: atpExpectedSignature) else {
        printJson(["ok": false, "error": "Frontmost application changed during moveLeft"])
        exit(1)
      }
    case "moveRight":
      guard let count = operationCount(operation) else {
        printJson(["ok": false, "error": "moveRight missing count"])
        exit(1)
      }
      guard pressKeyRepeated(keyCode: 124, count: count, targetPid: atpTargetPid, expectedElementSignature: atpExpectedSignature) else {
        printJson(["ok": false, "error": "Frontmost application changed during moveRight"])
        exit(1)
      }
    case "deleteForward":
      guard let count = operationCount(operation) else {
        printJson(["ok": false, "error": "deleteForward missing count"])
        exit(1)
      }
      guard pressKeyRepeated(keyCode: 117, count: count, targetPid: atpTargetPid, expectedElementSignature: atpExpectedSignature) else {
        printJson(["ok": false, "error": "Frontmost application changed during deleteForward"])
        exit(1)
      }
    case "insertText":
      guard let text = operation["text"] as? String else {
        printJson(["ok": false, "error": "insertText missing text"])
        exit(1)
      }
      guard postUnicodeTextInChunks(
        text,
        chunkSize: atpAllowUnverified ? blindKeyboardTextChunkSize : 16,
        targetPid: atpTargetPid,
        expectedElementSignature: atpExpectedSignature
      ) else {
        printJson(["ok": false, "error": "Frontmost application changed during insertText"])
        exit(1)
      }
    default:
      printJson(["ok": false, "error": "Unknown patch operation: \(kind)"])
      exit(1)
    }
  }
  printJson(["ok": true])

case "pressKeys":
  guard args.count >= 3 else {
    printJson(["ok": false, "error": "Expected base64 JSON key list [delayMs]"])
    exit(1)
  }
  guard let decoded = decodeBase64String(args[2]),
        let data = decoded.data(using: .utf8),
        let keys = try? JSONSerialization.jsonObject(with: data) as? [String],
        !keys.isEmpty else {
    printJson(["ok": false, "error": "Invalid key list"])
    exit(1)
  }
  let delayMs = parseIntArg(args, 3, default: 50)
  pressKeyCombo(keys, delayMs: delayMs)
  printJson(["ok": true])

case "pointer":
  let pointer = currentPointerTopLeft()
  printJson(["ok": true, "pointerX": pointer.x, "pointerY": pointer.y])

case "probeInputMonitoring":
  // Functional probe: start a listenOnly event tap and wait for a real physical input event.
  // Returns inputMonitoringGranted: true if a physical event is received within the timeout,
  // false otherwise. This reliably detects whether Input Monitoring permission is granted
  // even on macOS versions where CGEvent.tapCreate() succeeds without the permission.
  var probeMask: CGEventMask = 0
  probeMask |= (1 << CGEventType.mouseMoved.rawValue)
  probeMask |= (1 << CGEventType.leftMouseDown.rawValue)
  probeMask |= (1 << CGEventType.rightMouseDown.rawValue)
  probeMask |= (1 << CGEventType.scrollWheel.rawValue)
  probeMask |= (1 << CGEventType.keyDown.rawValue)
  probeMask |= (1 << CGEventType.flagsChanged.rawValue)

  let probeTimeoutMs = parseIntArg(args, 2, default: 3000)
  var probeReceivedEvent = false

  guard let probeTap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: probeMask,
    callback: { _, type, event, refcon in
      // Ignore tap-disabled signals — those aren't physical input
      if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        return Unmanaged.passUnretained(event)
      }

      let sourcePid = event.getIntegerValueField(.eventSourceUnixProcessID)
      let sourceTag = event.getIntegerValueField(.eventSourceUserData)
      // Only count events NOT from our own process and NOT our synthetic tag
      if sourcePid != Int64(getpid()) && sourceTag != syntheticEventTag {
        // Signal that we received a real physical event
        let receivedPtr = refcon!.assumingMemoryBound(to: Bool.self)
        receivedPtr.pointee = true
        CFRunLoopStop(CFRunLoopGetCurrent())
      }
      return Unmanaged.passUnretained(event)
    },
    userInfo: &probeReceivedEvent
  ) else {
    // Tap creation failed outright — no Input Monitoring permission
    printJson(["ok": true, "inputMonitoringGranted": false])
    break
  }

  let probeSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, probeTap, 0)
  CFRunLoopAddSource(CFRunLoopGetCurrent(), probeSource, .defaultMode)
  CGEvent.tapEnable(tap: probeTap, enable: true)

  // Run the loop for up to probeTimeoutMs — CFRunLoopStop in the callback exits early
  // if a physical event is received.
  let probeDeadline = Date(timeIntervalSinceNow: Double(probeTimeoutMs) / 1000.0)
  while !probeReceivedEvent && Date() < probeDeadline {
    CFRunLoopRunInMode(.defaultMode, 0.1, true)
  }

  // Clean up
  CGEvent.tapEnable(tap: probeTap, enable: false)
  CFRunLoopRemoveSource(CFRunLoopGetCurrent(), probeSource, .defaultMode)

  printJson(["ok": true, "inputMonitoringGranted": probeReceivedEvent])

case "monitor":
  let monitoredEventTypes: [CGEventType] = [
    .mouseMoved,
    .leftMouseDown,
    .leftMouseUp,
    .rightMouseDown,
    .rightMouseUp,
    .leftMouseDragged,
    .rightMouseDragged,
    .scrollWheel,
    .keyDown,
    .keyUp,
    .flagsChanged,
  ]
  let mask = monitoredEventTypes.reduce(CGEventMask(0)) { partialResult, eventType in
    partialResult | (CGEventMask(1) << Int(eventType.rawValue))
  }

  guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: CGEventMask(mask),
    callback: { _, type, event, _ in
      if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        printJson([
          "ok": false,
          "event": "monitor-disabled",
          "reason": type == .tapDisabledByTimeout ? "timeout" : "user-input",
        ])
        fflush(stdout)
        exit(75)
      }

      let sourcePid = event.getIntegerValueField(.eventSourceUnixProcessID)
      let sourceTag = event.getIntegerValueField(.eventSourceUserData)
      // Filter our own process and our tagged synthetic events.
      // NOTE: We intentionally do NOT filter by sourceState == .privateState
      // because third-party input software (Karabiner-Elements, Logi Options+,
      // BetterTouchTool, SteerMouse, etc.) commonly injects events using
      // privateState, and filtering those would silently suppress real human input.
      if sourcePid == Int64(getpid())
        || sourceTag == syntheticEventTag {
        return Unmanaged.passUnretained(event)
      }

      let location = event.location
      let topLeft = convertQuartzToTopLeft(location.x, location.y)
      var payload: [String: Any] = [
        "ok": true,
        "event": "takeover",
        "eventType": eventTypeName(type),
        "kind": eventKind(type),
        "x": topLeft.x,
        "y": topLeft.y,
        "timestampMs": Int(Date().timeIntervalSince1970 * 1000),
      ]

      if type == .keyDown || type == .keyUp || type == .flagsChanged {
        payload["keyCode"] = event.getIntegerValueField(.keyboardEventKeycode)
      }
      if type == .scrollWheel {
        payload["deltaX"] = event.getIntegerValueField(.scrollWheelEventDeltaAxis2)
        payload["deltaY"] = event.getIntegerValueField(.scrollWheelEventDeltaAxis1)
      }

      printJson(payload)
      return Unmanaged.passUnretained(event)
    },
    userInfo: nil
  ) else {
    printJson(["ok": false, "error": "Unable to start monitor tap. Grant Accessibility permissions and retry."])
    exit(1)
  }

  let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
  CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  printJson(["ok": true, "event": "monitor-started"])
  CFRunLoopRun()

case "screenshot":
  // args: screenshot <base64ExcludeApps> <jpegQuality> [displayIndex] [excludePid]
  // When displayIndex is provided, capture only that display (0-indexed from allDisplaysSorted).
  // When excludePid is provided, exclude all windows owned by that process (and its children).
  if #available(macOS 12.3, *) {
    let excludeAppNames: [String]
    if args.count >= 3, let decoded = decodeBase64String(args[2]),
       let data = decoded.data(using: .utf8),
       let names = try? JSONSerialization.jsonObject(with: data) as? [String] {
      excludeAppNames = names
    } else {
      excludeAppNames = []
    }
    let jpegQuality: Double
    if args.count >= 4, let q = Double(args[3]) {
      jpegQuality = max(0.1, min(q, 1.0))
    } else {
      jpegQuality = 0.8
    }
    let requestedDisplayIndex: Int? = args.count >= 5 ? Int(args[4]) : nil
    let excludePid: pid_t? = args.count >= 6 ? pid_t(args[5]) : nil

    let sem = DispatchSemaphore(value: 0)
    var captureResult: [String: Any] = ["ok": false, "error": "timeout"]

    Task {
      do {
        let content = try await SCShareableContent.current
        let allDisplays = content.displays.sorted {
          displaySortPrecedes($0.frame, $1.frame, lhsID: $0.displayID, rhsID: $1.displayID)
        }
        guard !allDisplays.isEmpty else {
          captureResult = ["ok": false, "error": "No displays found"]
          sem.signal()
          return
        }

        // Select the target display
        let targetDisplay: SCDisplay
        if let idx = requestedDisplayIndex, idx >= 0 && idx < allDisplays.count {
          targetDisplay = allDisplays[idx]
        } else {
          targetDisplay = allDisplays.first!
        }

        let excludeSet = Set(excludeAppNames.map { $0.lowercased() })
        let excludedWindows = content.windows.filter { window in
          guard let app = window.owningApplication else { return false }
          let layer = window.windowLayer
          // Only exclude normal application windows (layer 0) and our own
          // overlay windows (layer >= 1000, i.e. screen-saver level).
          // Everything else — menu bar (24), status items (25), dropdown
          // menus (3/101), dock (20), etc. — must be preserved, because
          // ScreenCaptureKit suppresses the entire composited contribution
          // of excluded windows, which hides system menus the AI needs.
          let isNormalWindow = layer == 0
          let isHighOverlay = layer >= 1000 && layer < 2_000_000_000
          if !isNormalWindow && !isHighOverlay { return false }
          // Exclude by PID (our own process's normal + overlay windows)
          if let pid = excludePid, app.processID == pid {
            return true
          }
          // Exclude other apps only at normal window level
          if isNormalWindow {
            return excludeSet.contains(app.applicationName.lowercased())
          }
          return false
        }

        let filter = SCContentFilter(display: targetDisplay, excludingWindows: excludedWindows)

        let captureWidth = max(1, Int(CGDisplayPixelsWide(targetDisplay.displayID)))
        let captureHeight = max(1, Int(CGDisplayPixelsHigh(targetDisplay.displayID)))

        let config = SCStreamConfiguration()
        config.width = captureWidth
        config.height = captureHeight
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false

        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)

        let bitmapRep = NSBitmapImageRep(cgImage: image)
        guard let jpegData = bitmapRep.representation(using: .jpeg, properties: [.compressionFactor: NSNumber(value: jpegQuality)]) else {
          captureResult = ["ok": false, "error": "JPEG encoding failed"]
          sem.signal()
          return
        }

        let base64 = jpegData.base64EncodedString()
        // Find which index this display is in our sorted list
        let actualIndex = allDisplays.firstIndex(where: { $0.displayID == targetDisplay.displayID }) ?? 0
        let displayInfo = buildDisplayLayoutArray(allDisplays)
        let thisDisplayInfo = actualIndex < displayInfo.count ? displayInfo[actualIndex] : [:]

        captureResult = [
          "ok": true,
          "imageBase64": base64,
          "width": captureWidth,
          "height": captureHeight,
          "displayIndex": actualIndex,
          "displayInfo": thisDisplayInfo,
          "displays": displayInfo,
        ]
      } catch {
        captureResult = ["ok": false, "error": error.localizedDescription]
      }
      sem.signal()
    }

    sem.wait()
    printJson(captureResult)
  } else {
    printJson(["ok": false, "error": "ScreenCaptureKit requires macOS 12.3+"])
    exit(1)
  }

case "displays":
  let layout = buildDisplayLayoutArray()
  printJson([
    "ok": true,
    "displays": layout,
    "displayCount": layout.count,
  ])

default:
  printJson(["ok": false, "error": "Unknown command"])
  exit(1)
}
`;
