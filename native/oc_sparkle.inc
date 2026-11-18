// Included by oc_native.mm: all ownership, KVO and delegate calls stay on AppKit's thread.
@interface OCUpdaterDelegate : NSObject <SPUUpdaterDelegate> {
@public
  std::weak_ptr<State> owner;
}
@property(nonatomic) BOOL probeOnly;
@property(nonatomic) BOOL started;
@property(nonatomic) BOOL observing;
@property(nonatomic) BOOL quitting;
@property(nonatomic, copy) NSString *phase;
@property(nonatomic, copy) NSString *availableVersion;
@property(nonatomic, copy) NSString *failure;
@property(nonatomic, copy) NSString *feed;
@property(nonatomic, copy) void (^installationContinuation)(void);
- (NSDictionary *)snapshot;
- (void)publish;
@end

@implementation OCUpdaterDelegate
- (NSDictionary *)snapshot {
  MainThread(); auto state = owner.lock();
  SPUUpdater *updater = state ? state->updaterController.updater : nil;
  NSDate *date = updater.lastUpdateCheckDate;
  return @{ @"currentVersion":[NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"unknown",
    @"availableVersion":self.availableVersion ?: (id)NSNull.null,
    @"phase":self.phase ?: @"idle", @"error":self.failure ?: (id)NSNull.null,
    @"canCheck":@(self.started && !self.quitting && updater.canCheckForUpdates && (!self.probeOnly || !updater.sessionInProgress)),
    @"automaticChecks":@(updater.automaticallyChecksForUpdates), @"probeOnly":@(self.probeOnly),
    @"sessionInProgress":@(updater.sessionInProgress),
    @"checkedAt":date ? [NSISO8601DateFormatter stringFromDate:date timeZone:NSTimeZone.localTimeZone formatOptions:NSISO8601DateFormatWithInternetDateTime] : (id)NSNull.null };
}
- (void)publish { MainThread(); auto state = owner.lock(); if (state) Emit(state, @"updaterChanged", 0, [self snapshot]); }
- (void)observeValueForKeyPath:(NSString *)key ofObject:(id)object change:(NSDictionary *)change context:(void *)context { [self publish]; }
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater { return self.feed; }
- (BOOL)updaterShouldPromptForPermissionToCheckForUpdates:(SPUUpdater *)updater { return !self.probeOnly && !self.quitting; }
- (BOOL)updater:(SPUUpdater *)updater mayPerformUpdateCheck:(SPUUpdateCheck)check error:(NSError **)error {
  if (self.quitting || (self.probeOnly && check != SPUUpdateCheckUpdateInformation)) {
    if (error) *error = [NSError errorWithDomain:@"OCSparkle" code:1 userInfo:@{NSLocalizedDescriptionKey:@"This instance only permits update information checks."}];
    return NO;
  }
  self.phase = @"checking"; self.failure = nil; self.availableVersion = nil; [self publish]; return YES;
}
- (void)updater:(SPUUpdater *)updater didFindValidUpdate:(SUAppcastItem *)item { self.availableVersion = item.displayVersionString; self.phase = @"available"; [self publish]; }
- (void)updaterDidNotFindUpdate:(SPUUpdater *)updater error:(NSError *)error {
  SUAppcastItem *item = error.userInfo[SPULatestAppcastItemFoundKey];
  self.availableVersion = item.displayVersionString; self.phase = @"no-update"; [self publish];
}
- (void)updater:(SPUUpdater *)updater willDownloadUpdate:(SUAppcastItem *)item withRequest:(NSMutableURLRequest *)request { self.phase = @"downloading"; [self publish]; }
- (void)updater:(SPUUpdater *)updater didDownloadUpdate:(SUAppcastItem *)item { self.phase = @"downloaded"; [self publish]; }
- (void)updater:(SPUUpdater *)updater willExtractUpdate:(SUAppcastItem *)item { self.phase = @"extracting"; [self publish]; }
- (void)updater:(SPUUpdater *)updater didExtractUpdate:(SUAppcastItem *)item { self.phase = @"ready-to-install"; [self publish]; }
- (void)updater:(SPUUpdater *)updater willInstallUpdate:(SUAppcastItem *)item { self.phase = @"installing"; [self publish]; }
- (void)userDidCancelDownload:(SPUUpdater *)updater { self.phase = @"cancelled"; [self publish]; }
- (void)updater:(SPUUpdater *)updater didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check error:(NSError *)error {
  if (error && !([error.domain isEqualToString:SUSparkleErrorDomain] && error.code == SUNoUpdateError)) {
    self.phase = @"error";
    // Preserve Sparkle's failure, bounded to the bridge envelope budget.
    NSString *message = [NSString stringWithFormat:@"%@ (%@:%ld)", error.localizedDescription, error.domain, (long)error.code];
    self.failure = message.length > 2048 ? [message substringToIndex:2048] : message;
  } else if ([self.phase isEqualToString:@"checking"]) { self.phase = @"idle"; }
  [self publish];
}
- (BOOL)updater:(SPUUpdater *)updater shouldPostponeRelaunchForUpdate:(SUAppcastItem *)item untilInvokingBlock:(void (^)(void))handler {
  MainThread();
  // Retain the block and controller until Rust finishes draining real work. Never
  // replace NSApplicationDelegate: Tao still owns its normal termination path.
  Require(!self.installationContinuation, "Sparkle installation continuation still pending");
  self.installationContinuation = handler; self.phase = @"awaiting-quit"; [self publish];
  auto state = owner.lock(); Require(state != nullptr, "Sparkle owner unavailable");
  Emit(state, @"updaterInstallRequested", 0, @{}); return YES;
}
@end

static NSDictionary *UpdaterCall(std::shared_ptr<State> state, NSString *command, NSDictionary *args) {
  MainThread(); OCUpdaterDelegate *delegate = state->updaterDelegate;
  if ([command isEqualToString:@"updaterStart"]) {
    Require(!state->updaterController, "Sparkle already started");
    bool development = BooleanArgument(args, @"development");
    delegate = [OCUpdaterDelegate new]; delegate->owner = state;
    delegate.probeOnly = development || state->acceptance; delegate.phase = @"idle";
    NSString *feed = [NSBundle.mainBundle objectForInfoDictionaryKey:@"SUFeedURL"];
    NSURL *url = [feed isKindOfClass:NSString.class] ? [NSURL URLWithString:feed] : nil;
    bool productionFeed = [feed isEqualToString:@"https://github.com/Zixiaobowen/oc-chan/releases/latest/download/appcast.xml"];
    bool loopback = [url.scheme isEqualToString:@"http"] && ([@[@"127.0.0.1", @"localhost", @"::1"] containsObject:url.host]) && !url.user && !url.password;
    Require(productionFeed || (delegate.probeOnly && loopback), "Sparkle feed is not an allowed production or isolated loopback URL");
    delegate.feed = feed; state->updaterDelegate = delegate;
    state->updaterController = [[SPUStandardUpdaterController alloc] initWithStartingUpdater:NO updaterDelegate:delegate userDriverDelegate:nil];
    Require(state->updaterController != nil, "Sparkle controller allocation failed");
    SPUUpdater *updater = state->updaterController.updater;
    if (delegate.probeOnly) { updater.automaticallyChecksForUpdates = NO; updater.automaticallyDownloadsUpdates = NO; }
    NSError *error = nil;
    delegate.started = [updater startUpdater:&error];
    if (!delegate.started) { delegate.phase = @"error"; delegate.failure = error.localizedDescription ?: @"Sparkle failed to start"; }
    for (NSString *key in @[@"canCheckForUpdates", @"sessionInProgress", @"automaticallyChecksForUpdates", @"lastUpdateCheckDate"]) {
      [updater addObserver:delegate forKeyPath:key options:0 context:nullptr];
    }
    delegate.observing = YES; [delegate publish]; return [delegate snapshot];
  }
  // Shutdown may run before startup reached the updater.
  if ([command isEqualToString:@"updaterPrepareToQuit"]) {
    if (!delegate) return @{ @"retainContext":@NO };
    delegate.quitting = YES; [delegate publish];
    return @{ @"retainContext":@(state->updaterController.updater.sessionInProgress || delegate.installationContinuation != nil) };
  }
  Require(delegate != nil, "Sparkle has not started");
  SPUUpdater *updater = state->updaterController.updater;
  if ([command isEqualToString:@"updaterRead"]) return [delegate snapshot];
  if ([command isEqualToString:@"updaterCheck"]) {
    Require([[delegate snapshot][@"canCheck"] boolValue], "Sparkle cannot check for updates now");
    if (delegate.probeOnly) [updater checkForUpdateInformation];
    else [state->updaterController checkForUpdates:nil];
  } else if ([command isEqualToString:@"updaterSetAutomaticChecks"]) {
    Require(delegate.started && !delegate.probeOnly && !delegate.quitting, "Sparkle automatic checks forbidden in acceptance or development");
    updater.automaticallyChecksForUpdates = BooleanArgument(args, @"enabled");
  } else if ([command isEqualToString:@"updaterResumeInstallation"]) {
    Require(delegate.quitting && delegate.installationContinuation != nil, "Sparkle installation continuation missing");
    void (^continuation)(void) = delegate.installationContinuation;
    delegate.installationContinuation = nil;
    // Queue after the bridge call returns; the context remains alive until exit.
    dispatch_async(dispatch_get_main_queue(), continuation);
  } else { throw std::runtime_error("unknown Sparkle command"); }
  return [delegate snapshot];
}
static void UpdaterRelease(std::shared_ptr<State> state) {
  MainThread(); OCUpdaterDelegate *delegate = state->updaterDelegate;
  if (!delegate) return;
  Require(!delegate.installationContinuation && !state->updaterController.updater.sessionInProgress, "Sparkle session still pending; context retained");
  if (delegate.observing) {
    for (NSString *key in @[@"canCheckForUpdates", @"sessionInProgress", @"automaticallyChecksForUpdates", @"lastUpdateCheckDate"]) [state->updaterController.updater removeObserver:delegate forKeyPath:key];
    delegate.observing = NO;
  }
  state->updaterController = nil; delegate->owner.reset(); state->updaterDelegate = nil;
}
