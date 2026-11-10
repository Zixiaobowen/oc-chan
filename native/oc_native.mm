#import "oc_native.h"
#import <AppKit/AppKit.h>
#import <ServiceManagement/ServiceManagement.h>
#import <UserNotifications/UserNotifications.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#import <objc/runtime.h>
#import <Carbon/Carbon.h>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>

// State is confined to the main thread. Apple completions capture shared_ptr by
// VALUE, then dispatch once to main. A busy slot is not freed before that dispatch.
struct State {
  std::atomic<bool> released{false};
  bool acceptance = false, busy = false, cancelled = false, authorization = false;
  uint64_t request = 0, lastRequest = 0;
  oc_native_callback callback = nullptr;
  void *userdata = nullptr;
  IOPMAssertionID assertion = kIOPMNullAssertionID;
  UNAuthorizationStatus permission = UNAuthorizationStatusNotDetermined;
  __strong NSMutableArray *observers = [NSMutableArray new];
  __strong NSMutableDictionary *notifications = [NSMutableDictionary new];
  __strong NSString *prefix = [[NSUUID UUID].UUIDString stringByAppendingString:@":"];
  __strong NSString *sending = nil;
  __strong id delegate = nil;
  __strong NSSavePanel *panel = nil;
  bool launchObserved = false, launchedAtLogin = false;
  std::atomic<unsigned> eventQueued{0};
  std::atomic<unsigned> eventOverflow{0};
};
struct oc_native_context { std::shared_ptr<State> state; };
static std::shared_ptr<State> currentState;
static const void *glassKey = &glassKey;

static NSString *Text(const char *value, size_t limit) {
  if (!value || strnlen(value, limit + 1) > limit) throw std::runtime_error("missing or oversized UTF-8 input");
  NSString *text = [[NSString alloc] initWithUTF8String:value];
  if (!text) throw std::runtime_error("invalid UTF-8");
  return text;
}
static void Require(bool condition, const char *message) { if (!condition) throw std::runtime_error(message); }
static void MainThread() { Require([NSThread isMainThread], "AppKit main thread required"); }
static std::shared_ptr<State> Checked(oc_native_context *context) {
  MainThread(); Require(context && currentState && context->state == currentState && !context->state->released, "invalid or released native context");
  return context->state;
}
static char *Copy(NSString *text) {
  const char *bytes = text.UTF8String;
  Require(bytes != nullptr, "UTF-8 conversion failed");
  char *result = strdup(bytes); if (!result) throw std::bad_alloc(); return result;
}
static NSString *JSON(id value) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
  if (!data) throw std::runtime_error((error.localizedDescription ?: @"JSON serialization failed").UTF8String);
  Require(data.length <= 64 * 1024, "native result exceeds 64KiB");
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}
static NSDictionary *Arguments(const char *text) {
  NSString *input = Text(text, 256 * 1024);
  NSError *error = nil;
  id value = [NSJSONSerialization JSONObjectWithData:[input dataUsingEncoding:NSUTF8StringEncoding] options:0 error:&error];
  Require([value isKindOfClass:NSDictionary.class], "arguments must be a JSON object");
  return value;
}
static bool BooleanArgument(NSDictionary *args, NSString *key) {
  id value = args[key];
  Require([value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID(), "boolean argument required");
  return [value boolValue];
}
static NSString *String(NSDictionary *args, NSString *key, size_t limit, bool empty = false) {
  id value = args[key];
  Require([value isKindOfClass:NSString.class] && (empty || [value length] > 0) && [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= limit, "string missing or exceeds limit");
  return value;
}
static int Failure(char **error, const char *stage, const char *message) {
  if (error && asprintf(error, "%s\n%s", stage, message ?: "unknown native failure") < 0) *error = nullptr;
  return -1;
}
#define OC_BEGIN const char *stage = "boundary"; try { @try {
#define OC_END } @catch (NSException *e) { return Failure(error, stage, e.reason.UTF8String); } } catch (const std::exception &e) { return Failure(error, stage, e.what()); } catch (...) { return Failure(error, stage, "unknown C++ exception"); }

static void Emit(std::shared_ptr<State> state, NSString *event, uint64_t request, id value, NSString *error = nil) {
  if (state->released || !state->callback) return;
  if (error.length > 2048) error = [[error substringToIndex:2048] stringByAppendingString:@" [error truncated at 2048 characters]"];
  NSDictionary *envelope = error ? @{ @"event":event, @"requestId":@(request), @"error":error } : @{ @"event":event, @"requestId":@(request), @"value":value ?: NSNull.null };
  NSString *json = JSON(envelope);
  state->callback(state->userdata, json.UTF8String);
}
static bool SleepRead(std::shared_ptr<State> state) {
  if (state->assertion == kIOPMNullAssertionID) return false;
  CFDictionaryRef properties = IOPMAssertionCopyProperties(state->assertion);
  Require(properties != nullptr, "cannot read IOPM assertion properties");
  NSDictionary *value = CFBridgingRelease(properties);
  NSNumber *level = value[(__bridge NSString *)kIOPMAssertionLevelKey];
  Require([level isKindOfClass:NSNumber.class], "IOPM assertion has no level");
  return level.intValue == kIOPMAssertionLevelOn;
}
static NSDictionary *SystemRead(std::shared_ptr<State> state) {
  NSString *appearance = [NSApp.effectiveAppearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameDarkAqua, NSAppearanceNameAqua]];
  NSWorkspace *workspace = NSWorkspace.sharedWorkspace;
  bool dark = [appearance isEqualToString:NSAppearanceNameDarkAqua];
  NSArray<NSString *> *languages = NSLocale.preferredLanguages;
  Require(languages.count > 0, "system preferred language unavailable");
  NSString *language = languages.firstObject;
  Require([language isKindOfClass:NSString.class] && language.length > 0 && [language lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= 64, "system preferred language invalid");
  return @{ @"dark":@(dark), @"appearance":dark ? @"dark" : @"light",
    @"systemLanguage":[language.lowercaseString hasPrefix:@"zh"] ? @"zh-CN" : @"en",
    @"reduceMotion":@(workspace.accessibilityDisplayShouldReduceMotion),
    @"reduceTransparency":@(workspace.accessibilityDisplayShouldReduceTransparency),
    @"increaseContrast":@(workspace.accessibilityDisplayShouldIncreaseContrast),
    @"invertColors":@(workspace.accessibilityDisplayShouldInvertColors),
    @"glassSupported":@(NSClassFromString(@"NSGlassEffectView") != Nil),
    @"dockVisible":@(NSApp.activationPolicy == NSApplicationActivationPolicyRegular),
    @"activationPolicy":@(NSApp.activationPolicy), @"preventSleep":@(SleepRead(state)) };
}
static NSWindow *Window(NSDictionary *args) {
  id address = args[@"window"];
  Require([address isKindOfClass:NSNumber.class], "window address required");
  uint64_t pointer = [address unsignedLongLongValue];
  for (NSWindow *window in NSApp.windows) {
    if ((uint64_t)(__bridge void *)window == pointer && window.contentView.window == window) return window;
  }
  throw std::runtime_error("address is not a live NSWindow");
}
static NSView *GlassHitTest(id, SEL, NSPoint) { return nil; }
static BOOL GlassAcceptsFirstResponder(id, SEL) { return NO; }
static Class GlassClass() {
  static Class result = Nil;
  if (result) return result;
  Class superclass = NSClassFromString(@"NSGlassEffectView");
  Require(superclass != Nil, "NSGlassEffectView unavailable");
  Class candidate = objc_allocateClassPair(superclass, "OCNativePassthroughGlassView", 0);
  Require(candidate != Nil, "glass class allocation failed");
  Method hit = class_getInstanceMethod(NSView.class, @selector(hitTest:));
  Method responder = class_getInstanceMethod(NSView.class, @selector(acceptsFirstResponder));
  if (!hit || !responder || !class_addMethod(candidate, @selector(hitTest:), (IMP)GlassHitTest, method_getTypeEncoding(hit)) || !class_addMethod(candidate, @selector(acceptsFirstResponder), (IMP)GlassAcceptsFirstResponder, method_getTypeEncoding(responder))) {
    objc_disposeClassPair(candidate); throw std::runtime_error("glass class configuration failed");
  }
  objc_registerClassPair(candidate); result = candidate; return result;
}
static NSDictionary *GlassSet(NSDictionary *args) {
  NSWindow *window = Window(args);
  id number = args[@"intensity"];
  Require([number isKindOfClass:NSNumber.class], "glass intensity required");
  double intensity = [number doubleValue];
  Require(std::isfinite(intensity) && std::trunc(intensity) == intensity && intensity >= 0 && intensity <= 100, "glass intensity must be integer 0..100");
  bool dark = BooleanArgument(args, @"dark");
  NSView *existing = objc_getAssociatedObject(window, glassKey);
  if (intensity == 0) {
    [existing removeFromSuperview]; objc_setAssociatedObject(window, glassKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    return @{ @"active":@NO, @"viewCount":@0 };
  }
  if (@available(macOS 26.0, *)) {
    NSView *container = window.contentView;
    Require(!existing || existing.superview == container, "glass view detached from content view");
    NSGlassEffectView *glass = existing ? (NSGlassEffectView *)existing : [[GlassClass() alloc] initWithFrame:container.bounds];
    Require(glass != nil, "glass allocation failed");
    glass.style = NSGlassEffectViewStyleRegular; glass.cornerRadius = 0;
    glass.appearance = [NSAppearance appearanceNamed:dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
    glass.tintColor = [NSColor colorWithWhite:dark ? 0.08 : 0.97 alpha:0.82 * (1.0 - intensity / 100.0)];
    glass.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable; glass.frame = container.bounds;
    if (!existing) { [container addSubview:glass positioned:NSWindowBelow relativeTo:nil]; objc_setAssociatedObject(window, glassKey, glass, OBJC_ASSOCIATION_RETAIN_NONATOMIC); }
    return @{ @"active":@YES, @"viewCount":@1 };
  }
  throw std::runtime_error("Liquid Glass requires macOS 26");
}
static bool Installed() {
  NSString *path = NSBundle.mainBundle.bundleURL.URLByResolvingSymlinksInPath.path;
  NSString *userApplications = [NSHomeDirectory() stringByAppendingPathComponent:@"Applications/"];
  return [path.pathExtension isEqualToString:@"app"] && ([path hasPrefix:@"/Applications/"] || [path hasPrefix:userApplications]);
}
static void ObserveLaunch(std::shared_ptr<State> state) {
  NSAppleEventDescriptor *event = NSAppleEventManager.sharedAppleEventManager.currentAppleEvent;
  if (event.eventClass == kCoreEventClass && event.eventID == kAEOpenApplication) {
    state->launchObserved = true;
    state->launchedAtLogin = [[event paramDescriptorForKeyword:keyAEPropData] enumCodeValue] == keyAELaunchedAsLogInItem;
  }
}
static NSDictionary *LoginRead(std::shared_ptr<State> state) {
  ObserveLaunch(state);
  if (@available(macOS 13.0, *)) {
    SMAppServiceStatus status = SMAppService.mainAppService.status;
    NSString *name = nil;
    switch (status) {
      case SMAppServiceStatusNotRegistered: name = @"not-registered"; break;
      case SMAppServiceStatusEnabled: name = @"enabled"; break;
      case SMAppServiceStatusRequiresApproval: name = @"requires-approval"; break;
      case SMAppServiceStatusNotFound: name = @"not-found"; break;
      default: throw std::runtime_error("unknown SMAppService status");
    }
    return @{ @"status":name, @"openAtLogin":@(status == SMAppServiceStatusEnabled), @"wasOpenedAtLogin":state->launchObserved ? @(state->launchedAtLogin) : NSNull.null, @"launchEventObserved":@(state->launchObserved), @"installed":@(Installed()) };
  }
  throw std::runtime_error("SMAppService requires macOS 13");
}

#include "oc_notifications.inc"
#include "oc_exports.inc"
