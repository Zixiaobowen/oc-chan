#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <node_api.h>
#include <cmath>
#include <cstdint>
#include <cstring>

static const void *kGlassViewKey = &kGlassViewKey;

static bool CheckNapi(napi_env env, napi_status status) {
  if (status == napi_ok) return true;
  if (status != napi_pending_exception) {
    const napi_extended_error_info *info = nullptr;
    napi_get_last_error_info(env, &info);
    napi_throw_error(env, nullptr, info && info->error_message ? info->error_message : "N-API operation failed");
  }
  return false;
}

static napi_value Error(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

static napi_value Result(napi_env env, bool active) {
  napi_value result, activeValue, countValue;
  if (!CheckNapi(env, napi_create_object(env, &result)) ||
      !CheckNapi(env, napi_get_boolean(env, active, &activeValue)) ||
      !CheckNapi(env, napi_create_uint32(env, active ? 1 : 0, &countValue)) ||
      !CheckNapi(env, napi_set_named_property(env, result, "active", activeValue)) ||
      !CheckNapi(env, napi_set_named_property(env, result, "viewCount", countValue))) return nullptr;
  return result;
}

// The class is created only when AppKit supplies NSGlassEffectView. A static
// subclass would reference an unavailable superclass when loading on older OSes.
static NSView *GlassHitTest(id, SEL, NSPoint) { return nil; }
static BOOL GlassAcceptsFirstResponder(id, SEL) { return NO; }

static Class GlassClass() {
  static Class glassClass = Nil;
  if (glassClass) return glassClass;
  Class superclass = NSClassFromString(@"NSGlassEffectView");
  if (!superclass) return Nil;
  Class candidate = objc_allocateClassPair(superclass, "OCChanPassthroughGlassView", 0);
  if (!candidate) [NSException raise:NSInternalInconsistencyException format:@"Cannot create the glass view class"];
  Method hitTest = class_getInstanceMethod([NSView class], @selector(hitTest:));
  Method acceptsFirstResponder = class_getInstanceMethod([NSView class], @selector(acceptsFirstResponder));
  if (!hitTest || !acceptsFirstResponder ||
      !class_addMethod(candidate, @selector(hitTest:), (IMP)GlassHitTest, method_getTypeEncoding(hitTest)) ||
      !class_addMethod(candidate, @selector(acceptsFirstResponder), (IMP)GlassAcceptsFirstResponder, method_getTypeEncoding(acceptsFirstResponder))) {
    objc_disposeClassPair(candidate);
    [NSException raise:NSInternalInconsistencyException format:@"Cannot configure the glass view class"];
  }
  objc_registerClassPair(candidate);
  glassClass = candidate;
  return glassClass;
}

static napi_value Supported(napi_env env, napi_callback_info) {
  if (![NSThread isMainThread]) return Error(env, "Liquid Glass must be accessed on the main thread");
  @autoreleasepool {
    bool available = false;
    if (@available(macOS 26.0, *)) available = NSClassFromString(@"NSGlassEffectView") != Nil;
    napi_value result;
    if (!CheckNapi(env, napi_get_boolean(env, available, &result))) return nullptr;
    return result;
  }
}

static napi_value SetGlass(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) return Error(env, "Liquid Glass must be accessed on the main thread");
  size_t argc = 4;
  napi_value args[4];
  if (!CheckNapi(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr))) return nullptr;
  if (argc != 3) {
    napi_throw_type_error(env, nullptr, "setGlass requires a native handle Buffer, integer intensity and boolean dark");
    return nullptr;
  }
  bool isBuffer = false;
  napi_valuetype intensityType, darkType;
  if (!CheckNapi(env, napi_is_buffer(env, args[0], &isBuffer)) ||
      !CheckNapi(env, napi_typeof(env, args[1], &intensityType)) ||
      !CheckNapi(env, napi_typeof(env, args[2], &darkType))) return nullptr;
  if (!isBuffer || intensityType != napi_number || darkType != napi_boolean) {
    napi_throw_type_error(env, nullptr, "Expected a native handle Buffer, integer intensity and boolean dark");
    return nullptr;
  }
  void *bytes = nullptr;
  size_t length = 0;
  double intensity;
  bool dark;
  if (!CheckNapi(env, napi_get_buffer_info(env, args[0], &bytes, &length)) ||
      !CheckNapi(env, napi_get_value_double(env, args[1], &intensity)) ||
      !CheckNapi(env, napi_get_value_bool(env, args[2], &dark))) return nullptr;
  if (length != sizeof(uintptr_t) || !bytes) {
    napi_throw_range_error(env, nullptr, "Native handle must contain exactly one NSView pointer");
    return nullptr;
  }
  if (!std::isfinite(intensity) || std::trunc(intensity) != intensity || intensity < 0 || intensity > 100) {
    napi_throw_range_error(env, nullptr, "Glass intensity must be an integer from 0 to 100");
    return nullptr;
  }
  uintptr_t address = 0;
  std::memcpy(&address, bytes, sizeof(address));
  if (!address) return Error(env, "Native handle is null");

  @autoreleasepool {
    @try {
      // Compare addresses against live windows before dereferencing a supplied
      // pointer. Electron exposes the window's NSView, not its NSWindow.
      NSWindow *window = nil;
      for (NSWindow *candidate in [NSApp windows]) {
        if (reinterpret_cast<uintptr_t>((__bridge void *)candidate.contentView) == address) {
          window = candidate;
          break;
        }
      }
      if (!window || !window.contentView || window.contentView.window != window)
        return Error(env, "Native handle does not belong to a live Electron window content view");
      NSView *container = window.contentView;
      NSView *existing = objc_getAssociatedObject(window, kGlassViewKey);
      if (intensity == 0) {
        [existing removeFromSuperview];
        objc_setAssociatedObject(window, kGlassViewKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        return Result(env, false);
      }
      if (@available(macOS 26.0, *)) {
        Class glassClass = GlassClass();
        if (!glassClass) return Error(env, "NSGlassEffectView is unavailable");
        if (existing && existing.superview != container)
          return Error(env, "The glass view no longer belongs to this window's content view");
        NSGlassEffectView *glass = existing ? (NSGlassEffectView *)existing : [[glassClass alloc] initWithFrame:container.bounds];
        if (!glass) return Error(env, "Cannot allocate NSGlassEffectView");
        glass.style = NSGlassEffectViewStyleRegular;
        glass.cornerRadius = 0;
        glass.appearance = [NSAppearance appearanceNamed:dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
        // Public AppKit has no blur-strength property. Higher intensity removes
        // the neutral tint's masking, revealing more of the regular glass.
        glass.tintColor = [NSColor colorWithWhite:dark ? 0.08 : 0.97 alpha:0.82 * (1.0 - intensity / 100.0)];
        glass.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        glass.frame = container.bounds;
        if (!existing) {
          [container addSubview:glass positioned:NSWindowBelow relativeTo:nil];
          // Window ownership bounds lifetime without a global registry or
          // notification observers; clearing the association releases it at 0.
          objc_setAssociatedObject(window, kGlassViewKey, glass, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
        return Result(env, true);
      }
      return Error(env, "Liquid Glass requires macOS 26 or later");
    } @catch (NSException *exception) {
      return Error(env, exception.reason.UTF8String ?: "AppKit Liquid Glass operation failed");
    }
  }
}

static napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"supported", nullptr, Supported, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setGlass", nullptr, SetGlass, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  if (!CheckNapi(env, napi_define_properties(env, exports, 2, properties))) return nullptr;
  return exports;
}

NAPI_MODULE(liquid_glass, Initialize)
