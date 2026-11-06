import AppKit
import ApplicationServices
import Darwin
import Security

enum NavigationError: String, Error {
    case unavailable = "OC_TERN_UNAVAILABLE"
    case identity = "OC_TERN_IDENTITY"
    case ambiguous = "OC_TERN_AMBIGUOUS"
    case target = "OC_TERN_TARGET"
    case protocolError = "OC_TERN_PROTOCOL"
    case accessibility = "OC_TERN_ACCESSIBILITY"
    case activation = "OC_TERN_ACTIVATION"
    case window = "OC_TERN_WINDOW"
}

let ternBundleID = "so.stencil.tern"
let ternTeamID = "VTLHGQC72S"
let maximumPathBytes = 4096
let maximumTitleLength = 4096

enum Command {
    case probe
    case present(pid_t, String, String)
}

// This phase is lexical only: invalid commands cannot enumerate apps, use AX, or activate.
func normalizedAbsolutePath(_ path: String) -> Bool {
    !path.isEmpty && path.utf8.count <= maximumPathBytes && path.hasPrefix("/") &&
        !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) &&
        URL(fileURLWithPath: path).standardizedFileURL.path == path
}

func parseCommand(_ arguments: [String]) throws -> Command {
    if arguments.count == 2, arguments[1] == "probe" { return .probe }
    guard arguments.count == 5, arguments[1] == "present" else {
        throw NavigationError.target
    }
    let pidText = arguments[2]
    let key = arguments[4]
    guard !pidText.isEmpty, pidText.utf8.count <= 10,
          pidText.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
          let pid = Int32(pidText), pid > 0,
          normalizedAbsolutePath(arguments[3]),
          key.utf8.count <= 128,
          key.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) ||
              (48...57).contains($0) || $0 == 46 || $0 == 95 || $0 == 45 }) else {
        throw NavigationError.target
    }
    return .present(pid, arguments[3], key)
}

struct TernIdentity {
    let application: NSRunningApplication
    let pid: pid_t
    let executable: String
    let bundle: String
    let launchDate: Date
}

func canonicalPath(_ url: URL) throws -> String {
    guard url.isFileURL else { throw NavigationError.identity }
    let path = url.standardizedFileURL.resolvingSymlinksInPath().path
    guard normalizedAbsolutePath(path) else { throw NavigationError.identity }
    return path
}

func processExecutable(_ pid: pid_t) throws -> String {
    // proc_info.h defines PROC_PIDPATHINFO_MAXSIZE as (4 * MAXPATHLEN), a macro Swift cannot import.
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    guard length > 0, Int(length) < buffer.count else { throw NavigationError.identity }
    return try canonicalPath(URL(fileURLWithPath: String(cString: buffer)))
}

func uniqueApplication() throws -> NSRunningApplication {
    let applications = NSRunningApplication.runningApplications(withBundleIdentifier: ternBundleID)
    guard !applications.isEmpty else { throw NavigationError.unavailable }
    guard applications.count == 1 else { throw NavigationError.ambiguous }
    let application = applications[0]
    guard application.processIdentifier > 0, !application.isTerminated,
          application.activationPolicy == .regular else { throw NavigationError.identity }
    return application
}

func sameRunningApplication(_ identity: TernIdentity) throws {
    let current = try uniqueApplication()
    guard current.processIdentifier == identity.pid,
          current.launchDate == identity.launchDate,
          let executableURL = current.executableURL, let bundleURL = current.bundleURL,
          try canonicalPath(executableURL) == identity.executable,
          try canonicalPath(bundleURL) == identity.bundle,
          try processExecutable(identity.pid) == identity.executable else {
        throw NavigationError.identity
    }
}

func verifiedIdentity() throws -> TernIdentity {
    let application = try uniqueApplication()
    guard let bundleURL = application.bundleURL, let executableURL = application.executableURL,
          let launchDate = application.launchDate else { throw NavigationError.identity }
    let bundlePath = try canonicalPath(bundleURL)
    let executablePath = try canonicalPath(executableURL)
    let bundle = Bundle(url: URL(fileURLWithPath: bundlePath))
    guard bundle?.bundleIdentifier == ternBundleID,
          bundle?.object(forInfoDictionaryKey: "CFBundlePackageType") as? String == "APPL",
          bundle?.object(forInfoDictionaryKey: "CFBundleExecutable") as? String == "tern",
          let declaredExecutable = bundle?.executableURL,
          try canonicalPath(declaredExecutable) == executablePath,
          executablePath == bundlePath + "/Contents/MacOS/tern",
          try processExecutable(application.processIdentifier) == executablePath else {
        throw NavigationError.identity
    }

    let flags = SecCSFlags(rawValue: 0)
    let requirementText = "identifier \"so.stencil.tern\" and anchor apple generic and " +
        "certificate 1[field.1.2.840.113635.100.6.2.6] and " +
        "certificate leaf[field.1.2.840.113635.100.6.1.13] and " +
        "certificate leaf[subject.OU] = \"VTLHGQC72S\""
    var requirement: SecRequirement?
    var runningCode: SecCode?
    let attributes = [kSecGuestAttributePid as String: NSNumber(value: application.processIdentifier)] as CFDictionary
    guard SecRequirementCreateWithString(requirementText as CFString, flags, &requirement) == errSecSuccess,
          let requirement,
          SecCodeCopyGuestWithAttributes(nil, attributes, flags, &runningCode) == errSecSuccess,
          let runningCode,
          SecCodeCheckValidity(runningCode, flags, requirement) == errSecSuccess else {
        throw NavigationError.identity
    }

    // Security binds dynamic validation to the running image, not just a bundle's plist.
    // Its static origin preserves the process's actual architecture (including Rosetta).
    var diskCode: SecStaticCode?
    var signedBundleURL: CFURL?
    var information: CFDictionary?
    let diskFlags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures)
    guard SecCodeCopyStaticCode(runningCode, flags, &diskCode) == errSecSuccess,
          let diskCode,
          SecStaticCodeCheckValidity(diskCode, diskFlags, requirement) == errSecSuccess,
          SecCodeCopyPath(diskCode, flags, &signedBundleURL) == errSecSuccess,
          let signedBundleURL,
          try canonicalPath(signedBundleURL as URL) == bundlePath,
          SecCodeCopySigningInformation(diskCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
          let info = information as? [String: Any],
          info[kSecCodeInfoIdentifier as String] as? String == ternBundleID,
          info[kSecCodeInfoTeamIdentifier as String] as? String == ternTeamID,
          let signedExecutable = info[kSecCodeInfoMainExecutable as String] as? URL,
          try canonicalPath(signedExecutable) == executablePath,
          SecCodeCheckValidity(runningCode, flags, requirement) == errSecSuccess else {
        throw NavigationError.identity
    }
    let identity = TernIdentity(application: application, pid: application.processIdentifier,
                                executable: executablePath, bundle: bundlePath, launchDate: launchDate)
    try sameRunningApplication(identity)
    return identity
}

// Each request and each traversal is bounded; the parent also owns a total command deadline.
final class AccessibilityContext {
    private let deadline = ProcessInfo.processInfo.systemUptime + 6
    private var remainingElements = 2048

    func beginScan() throws {
        try checkDeadline()
        remainingElements = 2048
    }

    func checkDeadline() throws {
        guard ProcessInfo.processInfo.systemUptime < deadline else { throw NavigationError.window }
    }

    func prepare(_ element: AXUIElement) throws {
        try checkDeadline()
        guard AXUIElementSetMessagingTimeout(element, 0.25) == .success else {
            throw NavigationError.window
        }
    }

    func attribute(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
        try prepare(element)
        var value: CFTypeRef?
        switch AXUIElementCopyAttributeValue(element, name as CFString, &value) {
        case .success: return value
        case .noValue, .attributeUnsupported: return nil
        default: throw NavigationError.window
        }
    }

    func string(_ element: AXUIElement, _ name: String) throws -> String? {
        guard let value = try attribute(element, name) else { return nil }
        guard CFGetTypeID(value) == CFStringGetTypeID() else { throw NavigationError.window }
        let text = value as! CFString
        guard CFStringGetLength(text) <= maximumTitleLength else { throw NavigationError.window }
        let result = text as String
        guard !result.unicodeScalars.contains(where: { $0.value < 32 || (127...159).contains($0.value) }) else {
            throw NavigationError.window
        }
        return result
    }

    func elements(_ element: AXUIElement, _ name: String) throws -> [AXUIElement] {
        try prepare(element)
        var count: CFIndex = 0
        let status = AXUIElementGetAttributeValueCount(element, name as CFString, &count)
        if status == .noValue || status == .attributeUnsupported { return [] }
        guard status == .success, count >= 0, count <= 256, count <= remainingElements else {
            throw NavigationError.window
        }
        if count == 0 { return [] }
        remainingElements -= count
        var values: CFArray?
        try prepare(element)
        guard AXUIElementCopyAttributeValues(element, name as CFString, 0, count, &values) == .success,
              let values, CFArrayGetCount(values) <= count else { throw NavigationError.window }
        var result: [AXUIElement] = []
        result.reserveCapacity(CFArrayGetCount(values))
        for index in 0..<CFArrayGetCount(values) {
            let value = Unmanaged<AnyObject>.fromOpaque(CFArrayGetValueAtIndex(values, index)).takeUnretainedValue()
            guard CFGetTypeID(value) == AXUIElementGetTypeID() else { throw NavigationError.window }
            result.append(value as! AXUIElement)
        }
        return result
    }

    func windowMenuItems(_ application: AXUIElement, prefix: String) throws -> [AXUIElement] {
        try beginScan()
        guard let value = try attribute(application, kAXMenuBarAttribute),
              CFGetTypeID(value) == AXUIElementGetTypeID() else { throw NavigationError.window }
        let menuBar = value as! AXUIElement
        var matches: [AXUIElement] = []
        for barItem in try elements(menuBar, kAXChildrenAttribute) {
            for menu in try elements(barItem, kAXChildrenAttribute) {
                for item in try elements(menu, kAXChildrenAttribute) {
                    if let title = try string(item, kAXTitleAttribute), title.hasPrefix(prefix),
                       try string(item, kAXIdentifierAttribute) == "makeKeyAndOrderFront:" {
                        matches.append(item)
                        guard matches.count == 1 else { throw NavigationError.window }
                    }
                }
            }
        }
        return matches
    }
}

func waitForFocusTick() {
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
}

func presentWindow(_ identity: TernIdentity, key: String) throws -> [String: Any] {
    guard AXIsProcessTrusted() else { throw NavigationError.accessibility }
    try sameRunningApplication(identity)
    guard identity.application.activate(options: [.activateIgnoringOtherApps]) else {
        throw NavigationError.activation
    }
    let pid = identity.pid
    let activationDeadline = ProcessInfo.processInfo.systemUptime + 1
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
        guard ProcessInfo.processInfo.systemUptime < activationDeadline else {
            throw NavigationError.activation
        }
        waitForFocusTick()
    }
    let context = AccessibilityContext()
    let application = AXUIElementCreateApplication(pid)
    let prefix = "[Tern \"\(key)\"] "
    var items: [AXUIElement] = []
    let menuDeadline = ProcessInfo.processInfo.systemUptime + 1.5
    repeat {
        items = try context.windowMenuItems(application, prefix: prefix)
        if !items.isEmpty { break }
        waitForFocusTick()
    } while ProcessInfo.processInfo.systemUptime < menuDeadline
    guard items.count == 1 else { throw NavigationError.window }
    let item = items[0]
    guard try context.attribute(item, kAXEnabledAttribute) as? Bool == true,
          let title = try context.string(item, kAXTitleAttribute), title.hasPrefix(prefix) else {
        throw NavigationError.window
    }
    try sameRunningApplication(identity)
    try context.prepare(item)
    guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else {
        throw NavigationError.window
    }
    let focusDeadline = ProcessInfo.processInfo.systemUptime + 2
    var focusedSince: TimeInterval?
    repeat {
        try context.beginScan()
        let windows = try context.elements(application, kAXWindowsAttribute)
        var focusedCount = 0
        for window in windows {
            if try context.string(window, kAXTitleAttribute) == title,
               try context.attribute(window, kAXMainAttribute) as? Bool == true,
               NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
                focusedCount += 1
            }
        }
        guard focusedCount <= 1 else { throw NavigationError.window }
        if focusedCount == 1 {
            let now = ProcessInfo.processInfo.systemUptime
            if let since = focusedSince, now - since >= 0.3 {
                try sameRunningApplication(identity)
                return ["pid": pid, "windowTitle": title, "main": true]
            }
            if focusedSince == nil { focusedSince = now }
        } else {
            focusedSince = nil
        }
        waitForFocusTick()
    } while ProcessInfo.processInfo.systemUptime < focusDeadline
    throw NavigationError.window
}

do {
    let command = try parseCommand(CommandLine.arguments)
    let identity = try verifiedIdentity()
    let result: [String: Any]
    switch command {
    case .probe:
        result = ["pid": identity.pid, "executable": identity.executable, "bundle": identity.bundle,
                  "bundleId": ternBundleID, "teamId": ternTeamID]
    case let .present(pid, executable, key):
        guard pid == identity.pid, executable == identity.executable else { throw NavigationError.identity }
        result = try presentWindow(identity, key: key)
    }
    let data = try JSONSerialization.data(withJSONObject: result)
    FileHandle.standardOutput.write(data)
} catch {
    let code = (error as? NavigationError) ?? .protocolError
    FileHandle.standardError.write(Data((code.rawValue + "\n").utf8))
    exit(1)
}
