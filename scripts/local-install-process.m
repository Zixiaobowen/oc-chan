// Development/install tool only. Never bundled into OC Chan.
// A forked application cannot exec until the parent has published its request.
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
extern char **environ;
static volatile sig_atomic_t interrupted = 0;
static void interruptGate(int signal) { (void)signal; interrupted = 1; close(STDIN_FILENO); }
static NSDictionary *fileIdentity(struct stat value) {
    return @{ @"dev": @((uint64_t)value.st_dev), @"ino": @((uint64_t)value.st_ino), @"uid": @((uint32_t)value.st_uid), @"mode": @((uint32_t)value.st_mode), @"nlink": @((uint64_t)value.st_nlink) };
}

static void fail(NSString *message) { fprintf(stderr, "%s\n", message.UTF8String); exit(1); }
static void json(id object) {
    NSError *error = nil;
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingSortedKeys | NSJSONWritingFragmentsAllowed error:&error];
    if (!bytes) fail(error.localizedDescription);
    if (fwrite(bytes.bytes, 1, bytes.length, stdout) != bytes.length || fputc('\n', stdout) == EOF || fflush(stdout) != 0) fail(@"Cannot publish native process response");
}
static pid_t parsePID(const char *text) {
    char *end = NULL; errno = 0; long value = strtol(text, &end, 10);
    if (errno || !end || *end || value <= 1 || value > INT_MAX) fail(@"Invalid process id");
    return (pid_t)value;
}
static NSDictionary *identity(pid_t pid) {
    struct proc_bsdinfo info = {0}; errno = 0;
    int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (size == 0 && (errno == ESRCH || errno == ENOENT)) return nil;
    if (size != sizeof(info)) fail(@"Cannot read complete native process birth identity");
    if (info.pbi_status == 5) return nil;
    char executable[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (proc_pidpath(pid, executable, sizeof(executable)) <= 0) {
        if (errno == ESRCH || errno == ENOENT) return nil;
        fail(@"Cannot read native executable path");
    }
    NSString *path = [NSString stringWithUTF8String:executable];
    if (!path) fail(@"Native executable path is not UTF-8");
    return @{ @"pid": @(pid), @"birth_seconds": @(info.pbi_start_tvsec), @"birth_fraction": @(info.pbi_start_tvusec), @"executable": path };
}
static NSString *workingDirectory(pid_t pid) {
    struct proc_vnodepathinfo info = {0};
    if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, sizeof(info)) != sizeof(info)) fail(@"Cannot read native process working directory");
    NSString *result = [NSString stringWithUTF8String:info.pvi_cdir.vip_path];
    if (!result) fail(@"Native working directory is not UTF-8");
    return result;
}
static NSString *canonical(const char *input) {
    char output[PATH_MAX];
    if (!realpath(input, output)) fail(@"Cannot resolve controlled path");
    NSString *result = [NSString stringWithUTF8String:output];
    if (!result || !result.isAbsolutePath) fail(@"Invalid controlled absolute path");
    return result;
}
static void gatedLaunch(const char *executableInput, const char *authorizationInput) {
    NSString *executable = canonical(executableInput);
    NSString *authorization = [NSString stringWithUTF8String:authorizationInput];
    if (!authorization || !authorization.isAbsolutePath || authorization.length > 4096 || ![authorization.lastPathComponent isEqualToString:@"authorization.json"]) fail(@"Invalid readiness authorization path");
    NSString *directory = canonical(authorization.stringByDeletingLastPathComponent.fileSystemRepresentation);
    if (![directory isEqualToString:authorization.stringByDeletingLastPathComponent]) fail(@"Readiness parent is not canonical");
    struct stat info, bundleInfo, lockInfo;
    if (lstat(directory.fileSystemRepresentation, &info) || !S_ISDIR(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 0777) != 0700) fail(@"Readiness parent is not a private owned directory");
    NSString *bundle = executable.stringByDeletingLastPathComponent.stringByDeletingLastPathComponent.stringByDeletingLastPathComponent;
    if (lstat(bundle.fileSystemRepresentation, &bundleInfo) || !S_ISDIR(bundleInfo.st_mode)) fail(@"Missing real application bundle");
    NSString *lockPath = [directory stringByAppendingPathComponent:@"gate.lock"];
    int lock = open(lockPath.fileSystemRepresentation, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    struct flock ownedLock = {0}; ownedLock.l_type = F_WRLCK; ownedLock.l_whence = SEEK_SET;
    if (lock < 0 || fcntl(lock, F_SETLK, &ownedLock) || fstat(lock, &lockInfo)) fail(@"Cannot acquire private POSIX launch lock");
    NSString *argument = [@"--oc-local-install-receipt=" stringByAppendingString:authorization];
    char *program = strdup(executable.fileSystemRepresentation), *flag = strdup(argument.UTF8String);
    if (!program || !flag) fail(@"Cannot allocate bounded launch arguments");
    NSString *log = [directory stringByAppendingPathComponent:@"application.log"];
    int output = open(log.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    int input = open("/dev/null", O_RDONLY | O_CLOEXEC), gate[2];
    if (output < 0 || input < 0 || pipe(gate)) fail(@"Cannot create launch descriptors");
    if (fcntl(gate[0], F_SETFD, FD_CLOEXEC) || fcntl(gate[1], F_SETFD, FD_CLOEXEC)) fail(@"Cannot protect launch gate descriptors");
    signal(SIGPIPE, SIG_IGN); signal(SIGINT, interruptGate); signal(SIGTERM, interruptGate); signal(SIGALRM, interruptGate); alarm(120);
    char *arguments[] = { program, flag, NULL };
    pid_t child = fork();
    if (child < 0) fail(@"Cannot fork application launch gate");
    if (child == 0) {
        signal(SIGINT, SIG_DFL); signal(SIGTERM, SIG_DFL); signal(SIGPIPE, SIG_DFL); signal(SIGALRM, SIG_DFL);
        close(gate[1]); close(lock);
        if (setpgid(0, 0) != 0 || dup2(input, STDIN_FILENO) < 0 || dup2(output, STDOUT_FILENO) < 0 || dup2(output, STDERR_FILENO) < 0) _exit(126);
        close(input); close(output);
        char value = 0; ssize_t count;
        do { count = read(gate[0], &value, 1); } while (count < 0 && errno == EINTR);
        close(gate[0]);
        if (count != 1 || value != 'G') _exit(125);
        execve(program, arguments, environ); _exit(127);
    }
    close(gate[0]); close(input); close(output);
    NSMutableDictionary *expected = [identity(child) mutableCopy];
    if (!expected) { close(gate[1]); waitpid(child, NULL, 0); fail(@"Launch gate exited before identity capture"); }
    expected[@"executable"] = executable;
    json(@{ @"installer": identity(getpid()), @"process": expected, @"bundle_identity": fileIdentity(bundleInfo), @"lock_identity": fileIdentity(lockInfo), @"lock": lockPath });
    char release = 0; ssize_t count;
    do { count = read(STDIN_FILENO, &release, 1); } while (count < 0 && errno == EINTR && !interrupted);
    BOOL released = count == 1 && release == 'G' && write(gate[1], &release, 1) == 1;
    close(gate[1]);
    if (released) {
        char completed = 0;
        do { count = read(STDIN_FILENO, &completed, 1); } while (count < 0 && errno == EINTR && !interrupted);
        if (count == 1 && completed == 'C' && [identity(child) isEqual:expected]) {
            close(lock); free(program); free(flag); return;
        }
        // This exact PID is our unreaped child; it cannot be reused before wait.
        if (kill(child, SIGTERM) != 0 && errno != ESRCH) fail(@"Cannot cancel launched application");
        BOOL reaped = NO;
        for (int attempt = 0; attempt < 50; attempt++) {
            pid_t result = waitpid(child, NULL, WNOHANG);
            if (result == child) { reaped = YES; break; }
            if (result < 0 && errno != EINTR) fail(@"Cannot wait for launched application");
            usleep(100000);
        }
        if (!reaped) {
            if (kill(-child, SIGKILL) != 0 && errno != ESRCH) fail(@"Cannot terminate owned application group");
            while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
        }
    } else while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
    close(lock); free(program); free(flag); exit(125);
}
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 3 && strcmp(argv[1], "inspect") == 0) {
            pid_t pid = parsePID(argv[2]); NSDictionary *process = identity(pid);
            json(@{ @"process": process ?: [NSNull null], @"cwd": process ? workingDirectory(pid) : [NSNull null] }); return 0;
        }
        if (argc == 4 && strcmp(argv[1], "launch") == 0) { gatedLaunch(argv[2], argv[3]); return 0; }
        if (argc == 3 && (strcmp(argv[1], "applications") == 0 || strcmp(argv[1], "quit") == 0)) {
            NSString *bundle = canonical(argv[2]); BOOL quit = strcmp(argv[1], "quit") == 0; NSMutableArray *results = [NSMutableArray array];
            for (NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications) {
                if (app.terminated || !app.bundleURL || ![app.bundleURL.URLByResolvingSymlinksInPath.path isEqualToString:bundle]) continue;
                NSDictionary *process = identity(app.processIdentifier); if (!process) continue;
                if (![process[@"executable"] hasPrefix:[bundle stringByAppendingString:@"/Contents/MacOS/"]]) fail(@"Application executable is outside its bundle");
                [results addObject:@{ @"process": process, @"ready": @(app.finishedLaunching) }];
                if (quit) {
                    if (![process isEqual:identity(app.processIdentifier)]) fail(@"Application process identity changed before quit");
                    if (![app terminate]) fail(@"Application refused graceful termination");
                }
            }
            json(results); return 0;
        }
        fail(@"Usage: local-install-process inspect PID | applications BUNDLE | quit BUNDLE | launch EXECUTABLE REQUEST");
    }
    return 1;
}
