// Explicit standalone acceptance executable; never linked into oc-chan.
// Usage: sparkle-install ROOT ROOT/fixture.app LOOPBACK_FEED TEST_PUBLIC_KEY
//                        EXPECTED_VERSION EXPECTED_EXECUTABLE_SHA256
// Build against the pinned Sparkle SDK, including its PrivateHeaders. The private
// authorization preflight below is confined to this version-pinned test harness.
#import <AppKit/AppKit.h>
#import <Sparkle/Sparkle.h>
extern "C" {
#import <Sparkle/SUInstallerLauncher+Private.h>
}
#import <CommonCrypto/CommonDigest.h>
#include <sys/stat.h>
#include <unistd.h>
#include <cstdlib>

static NSString *Target, *Feed, *Version, *ExpectedHash, *Executable;
static ino_t OriginalInode;
static dev_t OriginalDevice;
static NSUInteger Logs = 0;
static BOOL Finished = NO;
static void Log(NSString *phase, NSDictionary *details = @{}) {
  if (++Logs > 128) { fprintf(stderr, "acceptance log budget exceeded\n"); _Exit(2); }
  NSMutableDictionary *record = [details mutableCopy]; record[@"phase"] = phase;
  NSError *error = nil; NSData *data = [NSJSONSerialization dataWithJSONObject:record options:0 error:&error];
  if (!data || data.length > 4096) { fprintf(stderr, "acceptance log serialization failed\n"); _Exit(2); }
  fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout);
}
static void Fail(NSString *message) {
  Log(@"failed", @{@"error":message.length > 1024 ? [message substringToIndex:1024] : message}); _Exit(1);
}
static void Require(BOOL condition, NSString *message) { if (!condition) Fail(message); }
static NSString *Hash(NSString *path) {
  NSInputStream *stream = [NSInputStream inputStreamWithFileAtPath:path]; [stream open];
  CC_SHA256_CTX context; CC_SHA256_Init(&context); uint8_t buffer[65536]; uint64_t total = 0;
  for (;;) {
    NSInteger count = [stream read:buffer maxLength:sizeof(buffer)];
    if (count < 0) Fail(@"Cannot read fixture executable");
    if (count == 0) break;
    total += count; Require(total <= 512ULL * 1024 * 1024, @"Fixture executable exceeds budget");
    CC_SHA256_Update(&context, buffer, (CC_LONG)count);
  }
  [stream close]; unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256_Final(digest, &context);
  NSMutableString *result = [NSMutableString new]; for (unsigned char byte : digest) [result appendFormat:@"%02x", byte];
  return result;
}
static NSDictionary *Plist(void) {
  NSError *error = nil;
  NSData *bytes = [NSData dataWithContentsOfFile:[Target stringByAppendingPathComponent:@"Contents/Info.plist"] options:0 error:&error];
  Require(bytes && bytes.length < 65536, @"Fixture Info.plist missing or oversized");
  id value = [NSPropertyListSerialization propertyListWithData:bytes options:NSPropertyListImmutable format:nil error:&error];
  Require([value isKindOfClass:NSDictionary.class], @"Invalid fixture Info.plist"); return value;
}
static void Noninteractive(void) {
  struct stat host, parent;
  Require(lstat(Target.fileSystemRepresentation, &host) == 0 && S_ISDIR(host.st_mode) && host.st_uid == geteuid(), @"Fixture must remain a same-user directory");
  Require(lstat(Target.stringByDeletingLastPathComponent.fileSystemRepresentation, &parent) == 0 && S_ISDIR(parent.st_mode) && parent.st_uid == geteuid() && (parent.st_mode & 077) == 0, @"Fixture parent must remain private");
  Require(access(Target.fileSystemRepresentation, W_OK | X_OK) == 0 && access(Target.stringByDeletingLastPathComponent.fileSystemRepresentation, W_OK | X_OK) == 0, @"Fixture replacement is not writable");
  Require(!SPUSystemNeedsAuthorizationAccessForBundlePath(Target), @"Sparkle requires interactive authorization; refusing installation");
  for (NSWindow *window in NSApp.windows) Require(!window.visible, @"Unexpected visible harness window");
}
static void VerifyInstalled(void) {
  NSDictionary *plist = Plist();
  Require([plist[@"CFBundleVersion"] isEqualToString:Version], @"Installed build version differs from expected version");
  Require([plist[@"CFBundleShortVersionString"] isEqualToString:Version], @"Installed display version differs from expected version");
  Require([plist[@"CFBundleExecutable"] isEqualToString:Executable], @"Installed executable name changed");
  NSString *path = [Target stringByAppendingPathComponent:[@"Contents/MacOS" stringByAppendingPathComponent:Executable]];
  struct stat identity; Require(lstat(path.fileSystemRepresentation, &identity) == 0 && S_ISREG(identity.st_mode) && identity.st_uid == geteuid(), @"Installed executable has invalid identity");
  Require(identity.st_ino != OriginalInode || identity.st_dev != OriginalDevice, @"Executable file identity was not replaced");
  Require([Hash(path) isEqualToString:ExpectedHash], @"Installed executable digest differs from the supplied expected digest");
  Noninteractive();
  Log(@"verified", @{@"version":Version, @"sha256":ExpectedHash, @"oldInode":@(OriginalInode), @"inode":@(identity.st_ino), @"device":@(identity.st_dev)});
}

@interface AcceptanceDriver : NSObject <SPUUserDriver, SPUUpdaterDelegate>
@property(nonatomic) uint64_t downloaded;
@property(nonatomic) BOOL sawDownload;
@property(nonatomic) BOOL sawExtraction;
@property(nonatomic) BOOL sawInstallation;
@end
@implementation AcceptanceDriver
- (NSSet<NSString *> *)allowedChannelsForUpdater:(SPUUpdater *)updater {
  return [NSSet setWithObjects:@"regular", @"lts", nil];
}
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater { return Feed; }
- (BOOL)updaterShouldPromptForPermissionToCheckForUpdates:(SPUUpdater *)updater { return NO; }
- (BOOL)updaterShouldRelaunchApplication:(SPUUpdater *)updater { return NO; }
- (BOOL)updater:(SPUUpdater *)updater shouldDownloadReleaseNotesForUpdate:(SUAppcastItem *)item { return NO; }
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
  reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation { Log(@"checking"); }
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
  if (item.informationOnlyUpdate || ![item.versionString isEqualToString:Version] || ![item.fileURL.pathExtension.lowercaseString isEqualToString:@"zip"] || ![item.fileURL.scheme isEqualToString:@"http"] || ![item.fileURL.host isEqualToString:[NSURL URLWithString:Feed].host] || item.fileURL.user || item.fileURL.password) {
    reply(SPUUserUpdateChoiceSkip); Fail(@"Unexpected version, informational update or non-loopback ZIP asset");
  }
  // Only an application archive is acceptable. Package installers could prompt.
  Require([item.installationType isEqualToString:@"application"], @"Package installation is forbidden");
  Noninteractive(); Log(@"found", @{@"version":item.versionString}); reply(SPUUserUpdateChoiceInstall);
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)data { Fail(@"Release notes must not be requested"); }
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error { Fail(error.localizedDescription); }
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement { acknowledgement(); Fail(error.localizedDescription); }
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement { acknowledgement(); Fail(error.localizedDescription); }
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation { Noninteractive(); self.sawDownload = YES; Log(@"downloading"); }
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)length { Require(length <= 512ULL * 1024 * 1024, @"Archive exceeds acceptance budget"); }
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length { Require(length <= 512ULL * 1024 * 1024 - self.downloaded, @"Download exceeds acceptance budget"); self.downloaded += length; }
- (void)showDownloadDidStartExtractingUpdate { Noninteractive(); self.sawExtraction = YES; Log(@"extracting", @{@"downloadedBytes":@(self.downloaded)}); }
- (void)showExtractionReceivedProgress:(double)progress { /* No UI; completion is observed by the next actual driver stage. */ }
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply { Noninteractive(); Log(@"ready-to-install"); reply(SPUUserUpdateChoiceInstall); }
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated retryTerminatingApplication:(void (^)(void))retry {
  Noninteractive(); self.sawInstallation = YES; Log(@"installing", @{@"applicationTerminated":@(terminated)});
}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))acknowledgement {
  Require(!relaunched, @"Fixture must not relaunch");
  Require(self.sawDownload && self.sawExtraction && self.sawInstallation && self.downloaded > 0, @"Missing real download/extraction/install observations");
  VerifyInstalled(); Finished = YES; acknowledgement(); dispatch_async(dispatch_get_main_queue(), ^{ _Exit(0); });
}
- (void)dismissUpdateInstallation { Log(@"dismissed", @{@"verified":@(Finished)}); }
- (void)showUpdateInFocus { /* This acceptance driver never creates a window. */ }
- (void)updater:(SPUUpdater *)updater didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check error:(NSError *)error { if (error && !Finished) Fail(error.localizedDescription); }
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    Require(argc == 7, @"Usage: sparkle-install ROOT ROOT/fixture.app LOOPBACK_FEED TEST_PUBLIC_KEY EXPECTED_VERSION EXPECTED_EXECUTABLE_SHA256");
    Require(geteuid() != 0, @"Do not run acceptance as root");
    NSMutableArray<NSString *> *args = [NSMutableArray new];
    for (int index = 1; index < argc; index++) { NSString *value = [NSString stringWithUTF8String:argv[index]]; Require(value && value.length < 4096, @"Invalid argument"); [args addObject:value]; }
    NSString *root = args[0]; Target = args[1]; Feed = args[2]; NSString *key = args[3]; Version = args[4]; ExpectedHash = args[5];
    char canonicalRoot[PATH_MAX], canonicalTemp[PATH_MAX];
    Require(realpath(root.fileSystemRepresentation, canonicalRoot) != nullptr && [root isEqualToString:[NSString stringWithUTF8String:canonicalRoot]], @"Root must be a canonical directory without symlinks");
    Require(realpath(NSTemporaryDirectory().fileSystemRepresentation, canonicalTemp) != nullptr, @"Cannot resolve temporary root");
    NSString *temp = [NSString stringWithUTF8String:canonicalTemp];
    Require([root hasPrefix:[temp stringByAppendingString:@"/"]] || [root hasPrefix:@"/private/tmp/"], @"Root must be a newly owned temporary subdirectory");
    Require([Target isEqualToString:[root stringByAppendingPathComponent:@"fixture.app"]], @"Only ROOT/fixture.app can be replaced");
    NSURL *url = [NSURL URLWithString:Feed];
    Require([url.scheme isEqualToString:@"http"] && [@[@"127.0.0.1", @"localhost", @"::1"] containsObject:url.host] && !url.user && !url.password && !url.fragment, @"Only loopback HTTP feed is permitted");
    Require([[NSData alloc] initWithBase64EncodedString:key options:0].length == 32, @"A separate Ed25519 test public key is required");
    Require(Version.length > 0 && Version.length <= 64 && [Version rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789."] invertedSet]].location == NSNotFound, @"Expected version must be numeric");
    Require(ExpectedHash.length == 64 && [ExpectedHash rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet]].location == NSNotFound, @"Expected SHA256 must be lowercase hex");
    [NSApplication sharedApplication];
    if (NSApp.activationPolicy != NSApplicationActivationPolicyProhibited) [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    Require(NSApp.activationPolicy == NSApplicationActivationPolicyProhibited, @"Cannot prohibit visible activation");
    Noninteractive(); NSDictionary *plist = Plist();
    NSString *identifier = plist[@"CFBundleIdentifier"];
    Require([identifier isKindOfClass:NSString.class] && [identifier hasPrefix:@"org.occhan.acceptance.sparkle."] && identifier.length > 32, @"Fixture requires a unique acceptance-only bundle identifier");
    Require([NSRunningApplication runningApplicationsWithBundleIdentifier:identifier].count == 0, @"Fixture must not already be running");
    Require([plist[@"SUFeedURL"] isEqualToString:Feed] && [plist[@"SUPublicEDKey"] isEqualToString:key], @"Bundle feed/key must match isolated fixture inputs");
    Require([plist[@"SURequireSignedFeed"] isEqual:@YES] && [plist[@"SUVerifyUpdateBeforeExtraction"] isEqual:@YES] && [plist[@"SUSignedFeedFailureExpirationInterval"] isEqual:@0], @"Signed feed and archive verification must remain required");
    Require([plist[@"LSUIElement"] isEqual:@YES] && [plist[@"SUEnableSystemProfiling"] isEqual:@NO] && [plist[@"SUEnableJavaScript"] isEqual:@NO], @"Fixture must disable foreground UI, profiling and JavaScript");
    Require(![plist[@"CFBundleVersion"] isEqualToString:Version], @"Fixture must begin at a different version");
    Executable = plist[@"CFBundleExecutable"];
    Require([Executable isKindOfClass:NSString.class] && Executable.length > 0 && [Executable isEqualToString:Executable.lastPathComponent] && ![Executable isEqualToString:@".."], @"Invalid fixture executable name");
    NSString *executablePath = [Target stringByAppendingPathComponent:[@"Contents/MacOS" stringByAppendingPathComponent:Executable]];
    char canonicalExecutable[PATH_MAX];
    Require(realpath(executablePath.fileSystemRepresentation, canonicalExecutable) != nullptr && [executablePath isEqualToString:[NSString stringWithUTF8String:canonicalExecutable]], @"Fixture executable cannot traverse symlinks");
    struct stat identity; Require(lstat(executablePath.fileSystemRepresentation, &identity) == 0 && S_ISREG(identity.st_mode) && identity.st_uid == geteuid(), @"Invalid original executable identity");
    OriginalInode = identity.st_ino; OriginalDevice = identity.st_dev;
    Require(![Hash(executablePath) isEqualToString:ExpectedHash], @"New executable must differ from old executable");
    __attribute__((objc_precise_lifetime)) AcceptanceDriver *driver = [AcceptanceDriver new]; NSBundle *bundle = [NSBundle bundleWithPath:Target];
    Require(bundle != nil, @"Cannot load fixture bundle");
    __attribute__((objc_precise_lifetime)) SPUUpdater *updater = [[SPUUpdater alloc] initWithHostBundle:bundle applicationBundle:bundle userDriver:driver delegate:driver];
    updater.automaticallyChecksForUpdates = NO; updater.automaticallyDownloadsUpdates = NO;
    NSError *error = nil; Require([updater startUpdater:&error], error.localizedDescription ?: @"Sparkle failed to start");
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ Fail(@"Installation acceptance exceeded 120 seconds"); });
    [updater checkForUpdates];
    // Strong local owners live throughout the real asynchronous installation.
    [NSApp run]; (void)updater; (void)driver; Fail(@"Application run loop exited without a verified installation");
  }
}
