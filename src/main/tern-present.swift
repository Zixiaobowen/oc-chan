import AppKit
import ApplicationServices

struct NavigationError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

func attribute(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    switch status {
    case .success: return value
    case .noValue, .attributeUnsupported: return nil
    default: throw NavigationError("读取 Tern 原生窗口失败（\(name): \(status.rawValue)）。")
    }
}

func children(_ element: AXUIElement) throws -> [AXUIElement] {
    try attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

func windowMenuItems(_ application: AXUIElement, prefix: String) throws -> [AXUIElement] {
    guard let value = try attribute(application, kAXMenuBarAttribute) else {
        throw NavigationError("无法读取 Tern 的原生菜单栏。")
    }
    let menuBar = value as! AXUIElement
    var matches: [AXUIElement] = []
    for barItem in try children(menuBar) {
        for menu in try children(barItem) {
            for item in try children(menu) {
                if let title = try attribute(item, kAXTitleAttribute) as? String,
                   title.hasPrefix(prefix),
                   try attribute(item, kAXIdentifierAttribute) as? String == "makeKeyAndOrderFront:" {
                    matches.append(item)
                }
            }
        }
    }
    return matches
}

func presentWindow(prefix: String) throws {
    let applications = NSRunningApplication.runningApplications(withBundleIdentifier: "so.stencil.tern")
    guard applications.count == 1 else {
        throw NavigationError("未找到唯一的 Tern 图形应用（\(applications.count) 个），请确认 Tern 正在运行。")
    }
    let running = applications[0]
    let pid = running.processIdentifier
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    guard AXIsProcessTrustedWithOptions(options) else {
        throw NavigationError("请在系统设置 → 隐私与安全性 → 辅助功能中允许 OC Chan，然后重试跳转。")
    }
    let application = AXUIElementCreateApplication(pid)
    // The caller sends the activation Apple Event; wait for its asynchronous completion.
    let activationDeadline = Date().addingTimeInterval(1)
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
        guard Date() < activationDeadline else {
            throw NavigationError("macOS 未将 Tern 切到前台，请重试。")
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    var items: [AXUIElement] = []
    let menuDeadline = Date().addingTimeInterval(1.5)
    repeat {
        items = try windowMenuItems(application, prefix: prefix)
        if !items.isEmpty { break }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    } while Date() < menuDeadline
    guard items.count == 1 else {
        throw NavigationError("未找到唯一的 Tern 原生窗口（匹配 \(items.count) 个）。请检查 OC Chan Window Navigation 插件是否启用。")
    }
    let item = items[0]
    guard try attribute(item, kAXEnabledAttribute) as? Bool == true,
          let title = try attribute(item, kAXTitleAttribute) as? String else {
        throw NavigationError("目标 Tern 原生窗口菜单项不可用。")
    }
    let pressed = AXUIElementPerformAction(item, kAXPressAction as CFString)
    guard pressed == .success else {
        throw NavigationError("macOS 未能显示目标 Tern 窗口（\(pressed.rawValue)）。")
    }
    let focusDeadline = Date().addingTimeInterval(2)
    var focusedSince: Date?
    repeat {
        let windows = try attribute(application, kAXWindowsAttribute) as? [AXUIElement] ?? []
        var focused = false
        for window in windows {
            if try attribute(window, kAXTitleAttribute) as? String == title,
               try attribute(window, kAXMainAttribute) as? Bool == true,
               NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
                focused = true
                break
            }
        }
        if focused {
            if let since = focusedSince, Date().timeIntervalSince(since) >= 0.3 {
                let result: [String: Any] = ["pid": pid, "windowTitle": title, "main": true]
                let data = try JSONSerialization.data(withJSONObject: result)
                FileHandle.standardOutput.write(data)
                return
            }
            if focusedSince == nil { focusedSince = Date() }
        } else {
            focusedSince = nil
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    } while Date() < focusDeadline
    throw NavigationError("目标标签页已选中，但未确认对应原生窗口显示在前台。")
}

do {
    guard CommandLine.arguments.count == 2,
          CommandLine.arguments[1].hasPrefix("[Tern ") else {
        throw NavigationError("无效的 Tern 原生窗口参数。")
    }
    try presentWindow(prefix: CommandLine.arguments[1])
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
