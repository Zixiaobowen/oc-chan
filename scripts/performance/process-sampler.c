#define _DARWIN_C_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stddef.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

/* Diagnostic-only executable. No target argv/environment/command lines are read.
 * The admin connection authenticates its unprivileged owner with kernel peer credentials.
 * All storage is bounded; saturation fails instead of silently truncating data.
 * CPU totals from PROC_PIDTASKALLINFO use Mach absolute time on Darwin; convert
 * with this host's timebase before reporting nanoseconds. Resource fields
 * are null when unavailable. Lifecycle maxRssBytes is a sampled maximum, never
 * an absolute peak; cpuNs/fdCount are the last valid sample, not exit counters.
 * coverage.complete describes API observations only: between-scan descendants
 * and activity before roots/track admission can be missed. A shutdown with live
 * tracks sets incomplete. SIGINT/TERM stops only this executable. */
enum { MAX_SYSTEM = 16384, MAX_KNOWN = 4096, MAX_TRACKED = 512,
       MAX_FDS = 65536, MAX_LINE = 128, OUTPUT_BYTES = 2097152 };
enum { UNCLASSIFIED, APP, DEVELOPMENT, EXCLUDED, OUTSIDE };
typedef struct { pid_t pid; uint64_t sec, usec; } Identity;
typedef struct { Identity id; unsigned group; } Known;
typedef struct {
    pid_t pid;
    struct proc_bsdinfo bsd;
    bool valid;
    unsigned group;
} Node;
typedef struct {
    uint64_t attempts, denied, vanished, other, identityChanges;
    uint64_t systemPids, systemIdentified, resourceProcesses;
    uint64_t rssSamples, cpuSamples, fdSamples, lifecycleSamples, missedLifecycles;
} Coverage;
typedef struct {
    bool present, rssValid, cpuValid, fdValid;
    uint64_t rss, cpu, fd;
    int taskError, fdError, identityError;
} Measurement;
typedef struct {
    uint64_t processes, rss, cpu, fd;
} ObservedCoverage;
typedef struct {
    Identity id;
    pid_t parent;
    uint64_t samples, maxRss, cpu, fd;
    bool rssValid, cpuValid, fdValid, incomplete;
} Track;
static pid_t pidBuffer[MAX_SYSTEM + 1];
static Node nodes[MAX_SYSTEM];
static size_t nodeCount;
static Known known[MAX_KNOWN];
static size_t knownCount;
static Track tracked[MAX_TRACKED];
static size_t trackedCount;
/* Explicit identities come only from the runner's authenticated WK instance
 * observations. Never infer XPC ownership from a name, UID or parent process. */
typedef struct { Identity id; uint64_t admitted; } Association;
static Association associated[16];
static size_t associatedCount;
static struct proc_fdinfo fdBuffer[MAX_FDS + 1];
static size_t walk[MAX_SYSTEM];
static char output[OUTPUT_BYTES];
static size_t outputSize;
static Coverage coverage;
static volatile sig_atomic_t interrupted;
static pid_t selfPid, ownerPid;
static uid_t ownerUid;
static Identity ownerIdentity;
static bool configured;
static mach_timebase_info_data_t timebase;

static void fail(const char *message) {
    fprintf(stderr, "process-sampler: %s\n", message);
    exit(EXIT_FAILURE);
}
static void on_signal(int signo) { (void)signo; interrupted = 1; }
static uint64_t clock_ns(clockid_t clock) {
    struct timespec ts;
    if (clock_gettime(clock, &ts) != 0) fail("clock_gettime failed");
    return (uint64_t)ts.tv_sec * UINT64_C(1000000000) + (uint64_t)ts.tv_nsec;
}
static double wall_ms(void) { return (double)clock_ns(CLOCK_REALTIME) / 1e6; }
static uint64_t monotonic_ns(void) { return clock_ns(CLOCK_MONOTONIC); }
static void append(const char *format, ...) {
    va_list args;
    va_start(args, format);
    int count = vsnprintf(output + outputSize, sizeof(output) - outputSize, format, args);
    va_end(args);
    if (count < 0 || (size_t)count >= sizeof(output) - outputSize)
        fail("JSON output capacity exceeded");
    outputSize += (size_t)count;
}
static void flush_output(void) {
    size_t offset = 0;
    uint64_t deadline = monotonic_ns() + UINT64_C(1000000000);
    while (offset < outputSize && !interrupted) {
        ssize_t size = write(STDOUT_FILENO, output + offset, outputSize - offset);
        if (size > 0) { offset += (size_t)size; continue; }
        if (size < 0 && errno == EINTR) continue;
        if (size < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            if (monotonic_ns() >= deadline) fail("stdout backpressure exceeded 1 second");
            struct pollfd fd = { .fd = STDOUT_FILENO, .events = POLLOUT };
            int result = poll(&fd, 1, 20);
            if (result < 0 && errno != EINTR) fail("stdout poll failed");
            if (result > 0 && (fd.revents & (POLLERR | POLLHUP | POLLNVAL)))
                fail("stdout closed");
            continue;
        }
        fail("stdout write failed");
    }
    outputSize = 0;
}
static void record_error(int error) {
    if (error == EPERM || error == EACCES) coverage.denied++;
    else if (error == ESRCH || error == ENOENT) coverage.vanished++;
    else coverage.other++;
}
static bool read_bsd(pid_t pid, struct proc_bsdinfo *bsd) {
    coverage.attempts++;
    errno = 0;
    int count = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, bsd, sizeof(*bsd));
    if (count != (int)sizeof(*bsd)) { record_error(errno); return false; }
    if (bsd->pbi_pid != (uint32_t)pid) { coverage.identityChanges++; errno = ESTALE; return false; }
    return true;
}
static Identity identity(const struct proc_bsdinfo *bsd) {
    return (Identity){ (pid_t)bsd->pbi_pid, bsd->pbi_start_tvsec, bsd->pbi_start_tvusec };
}
static bool equal_id(Identity a, Identity b) {
    return a.pid == b.pid && a.sec == b.sec && a.usec == b.usec;
}
static bool older_or_equal(Identity parent, Identity child) {
    return parent.sec < child.sec || (parent.sec == child.sec && parent.usec <= child.usec);
}
static void require_owner(void) {
    struct proc_bsdinfo current;
    if (!read_bsd(ownerPid, &current) || !equal_id(ownerIdentity, identity(&current)) ||
        current.pbi_uid != ownerUid || current.pbi_ruid != ownerUid)
        fail("sampler owner exited or changed identity/credentials");
}
static int compare_nodes(const void *a, const void *b) {
    pid_t left = ((const Node *)a)->pid, right = ((const Node *)b)->pid;
    return (left > right) - (left < right);
}
static Node *find_node(pid_t pid) {
    size_t low = 0, high = nodeCount;
    while (low < high) {
        size_t mid = low + (high - low) / 2;
        if (nodes[mid].pid < pid) low = mid + 1;
        else high = mid;
    }
    return low < nodeCount && nodes[low].pid == pid ? &nodes[low] : NULL;
}
static Known *find_known(pid_t pid) {
    for (size_t i = 0; i < knownCount; i++) if (known[i].id.pid == pid) return &known[i];
    return NULL;
}
static void remember(Identity id, unsigned group) {
    Known *entry = find_known(id.pid);
    if (entry) {
        if (!equal_id(entry->id, id)) coverage.identityChanges++;
        *entry = (Known){ id, group };
        return;
    }
    if (knownCount == MAX_KNOWN) fail("application/development identity limit exceeded");
    known[knownCount++] = (Known){ id, group };
}
static void enumerate(void) {
    coverage.attempts++;
    errno = 0;
    int count = proc_listallpids(pidBuffer, sizeof(pidBuffer));
    if (count <= 0) fail("system PID enumeration failed");
    if (count > MAX_SYSTEM) fail("system PID limit exceeded");
    nodeCount = 0;
    for (int i = 0; i < count; i++) {
        if (pidBuffer[i] <= 0) continue;
        Node *node = &nodes[nodeCount++];
        memset(node, 0, sizeof(*node));
        node->pid = pidBuffer[i];
        node->valid = read_bsd(node->pid, &node->bsd);
        if (node->valid) coverage.systemIdentified++;
    }
    coverage.systemPids += nodeCount;
    qsort(nodes, nodeCount, sizeof(nodes[0]), compare_nodes);
    for (size_t i = 1; i < nodeCount; i++)
        if (nodes[i - 1].pid == nodes[i].pid) fail("duplicate PID in system snapshot");
}
static bool descends_from(pid_t child, pid_t ancestor) {
    for (size_t depth = 0; depth <= nodeCount; depth++) {
        Node *node = find_node(child);
        if (!node || !node->valid || node->bsd.pbi_uid != ownerUid || node->bsd.pbi_ruid != ownerUid) return false;
        if (child == ancestor) return true;
        pid_t parent = (pid_t)node->bsd.pbi_ppid;
        Node *up = find_node(parent);
        if (!up || !up->valid || !older_or_equal(identity(&up->bsd), identity(&node->bsd)))
            return false;
        child = parent;
    }
    return false;
}
static void classify(void) {
    for (size_t i = 0; i < knownCount;) {
        Node *node = find_node(known[i].id.pid);
        if (!node || (node->valid && !equal_id(known[i].id, identity(&node->bsd)))) {
            if (node) coverage.identityChanges++;
            known[i] = known[--knownCount];
            continue;
        }
        node->group = known[i].group;
        i++;
    }
    Node *sampler = find_node(selfPid);
    if (sampler) sampler->group = EXCLUDED;
    for (size_t i = 0; i < nodeCount; i++) {
        Node *node = &nodes[i];
        size_t length = 0;
        while (node && node->group == UNCLASSIFIED && node->valid) {
            if (length == nodeCount) fail("cycle in process ancestry");
            walk[length++] = (size_t)(node - nodes);
            Node *parent = find_node((pid_t)node->bsd.pbi_ppid);
            if (parent && parent->valid &&
                !older_or_equal(identity(&parent->bsd), identity(&node->bsd))) parent = NULL;
            node = parent;
        }
        /* Cached identities remain measurable after a failed BSD read, but an
         * unverified current ancestor must never authorize a new identity. */
        unsigned group = node && node->valid && node->group != UNCLASSIFIED ? node->group : OUTSIDE;
        while (length) nodes[walk[--length]].group = group;
    }
    for (size_t i = 0; i < nodeCount; i++)
        if (nodes[i].valid && (nodes[i].group == APP || nodes[i].group == DEVELOPMENT))
            remember(identity(&nodes[i].bsd), nodes[i].group);
}
static Measurement measure(Identity id) {
    Measurement result = {0};
    struct proc_taskallinfo info;
    coverage.attempts++;
    errno = 0;
    int count = proc_pidinfo(id.pid, PROC_PIDTASKALLINFO, 0, &info, sizeof(info));
    if (count != (int)sizeof(info)) {
        result.taskError = errno ? errno : EIO;
        record_error(result.taskError);
        return result;
    }
    if (!equal_id(id, identity(&info.pbsd))) {
        coverage.identityChanges++;
        result.identityError = ESTALE;
        return result;
    }
    result.present = true;
    result.rssValid = result.cpuValid = true;
    result.rss = info.ptinfo.pti_resident_size;
    if (UINT64_MAX - info.ptinfo.pti_total_user < info.ptinfo.pti_total_system)
        fail("CPU counter overflow");
    uint64_t ticks = info.ptinfo.pti_total_user + info.ptinfo.pti_total_system;
    __uint128_t nanos = (__uint128_t)ticks * timebase.numer / timebase.denom;
    if (nanos > UINT64_MAX) fail("converted CPU counter overflow");
    result.cpu = (uint64_t)nanos;
    coverage.attempts++;
    errno = 0;
    count = proc_pidinfo(id.pid, PROC_PIDLISTFDS, 0, fdBuffer, sizeof(fdBuffer));
    if (count < 0 || (count == 0 && errno != 0)) result.fdError = errno ? errno : EIO;
    else if ((size_t)count >= sizeof(fdBuffer)) fail("file descriptor limit exceeded");
    else if ((size_t)count % sizeof(fdBuffer[0]) != 0) result.fdError = EIO;
    else { result.fdValid = true; result.fd = (uint64_t)count / sizeof(fdBuffer[0]); }
    if (result.fdError) record_error(result.fdError);
    struct proc_bsdinfo after;
    if (!read_bsd(id.pid, &after)) {
        result.identityError = errno ? errno : EIO;
        result.fdValid = false;
        return result;
    }
    if (!equal_id(id, identity(&after))) {
        coverage.identityChanges++;
        result.identityError = ESTALE;
        result.fdValid = false;
        return result;
    }
    return result;
}
static void number_or_null(bool valid, uint64_t value) {
    if (valid) append("%" PRIu64, value); else append("null");
}
static void json_name(const char *name, size_t capacity) {
    append("\"");
    size_t length = strnlen(name, capacity);
    for (size_t i = 0; i < length;) {
        unsigned char c = (unsigned char)name[i];
        if (c == '"' || c == '\\') { append("\\%c", c); i++; }
        else if (c < 0x20) { append("\\u%04x", c); i++; }
        else if (c < 0x80) { append("%c", c); i++; }
        else {
            size_t width = c >= 0xc2 && c <= 0xdf ? 2 :
                c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0;
            bool valid = width && i + width <= length;
            for (size_t j = 1; valid && j < width; j++)
                valid = ((unsigned char)name[i + j] & 0xc0) == 0x80;
            if (valid && width >= 3) {
                unsigned char next = (unsigned char)name[i + 1];
                if ((c == 0xe0 && next < 0xa0) || (c == 0xed && next >= 0xa0) ||
                    (c == 0xf0 && next < 0x90) || (c == 0xf4 && next >= 0x90)) valid = false;
            }
            if (valid) { append("%.*s", (int)width, name + i); i += width; }
            else { append("\\ufffd"); i++; }
        }
    }
    append("\"");
}
static ObservedCoverage emit_processes(unsigned group) {
    ObservedCoverage observed = {0};
    bool first = true;
    append("[");
    for (size_t i = 0; i < nodeCount; i++) {
        Node *node = &nodes[i];
        if (node->group != group) continue;
        Known *entry = find_known(node->pid);
        if (!entry) continue;
        Identity id = entry->id;
        Measurement measurement = measure(id);
        observed.processes++;
        observed.rss += measurement.rssValid;
        observed.cpu += measurement.cpuValid;
        observed.fd += measurement.fdValid;
        coverage.resourceProcesses++;
        coverage.rssSamples += measurement.rssValid;
        coverage.cpuSamples += measurement.cpuValid;
        coverage.fdSamples += measurement.fdValid;
        append("%s{\"pid\":%d,\"ppid\":", first ? "" : ",", id.pid);
        if (node->valid) append("%u", node->bsd.pbi_ppid); else append("null");
        append(",\"startId\":\"%" PRIu64 ":%06" PRIu64 "\",\"name\":", id.sec, id.usec);
        if (node->valid) json_name(node->bsd.pbi_comm, sizeof(node->bsd.pbi_comm));
        else append("null");
        append(",\"rssBytes\":"); number_or_null(measurement.rssValid, measurement.rss);
        append(",\"cpuNs\":"); number_or_null(measurement.cpuValid, measurement.cpu);
        append(",\"fdCount\":"); number_or_null(measurement.fdValid, measurement.fd);
        if (measurement.taskError || measurement.fdError || measurement.identityError)
            append(",\"sampleErrors\":{\"taskInfo\":%d,\"descriptors\":%d,\"identity\":%d}",
                   measurement.taskError, measurement.fdError, measurement.identityError);
        if (measurement.taskError == ESRCH || measurement.identityError == ESRCH)
            append(",\"sampleState\":\"exited\"");
        append("}");
        first = false;
    }
    append("]");
    return observed;
}
static ObservedCoverage emit_associated(void) {
    ObservedCoverage observed = {0};
    append("[");
    for (size_t i = 0; i < associatedCount; i++) {
        Identity id = associated[i].id;
        uint64_t age = monotonic_ns() - associated[i].admitted;
        Measurement value = {0};
        if (age <= UINT64_C(2000000000)) value = measure(id);
        else value.identityError = ESTALE;
        if (value.identityError) value.rssValid = value.cpuValid = value.fdValid = false;
        observed.processes++; observed.rss += value.rssValid;
        observed.cpu += value.cpuValid; observed.fd += value.fdValid;
        append("%s{\"pid\":%d,\"startId\":\"%" PRIu64 ":%06" PRIu64 "\",\"associationAgeMs\":%.3f,\"mayBeShared\":true,\"rssBytes\":", i ? "," : "", id.pid, id.sec, id.usec, (double)age / 1e6);
        number_or_null(value.rssValid, value.rss);
        append(",\"cpuNs\":"); number_or_null(value.cpuValid, value.cpu);
        append(",\"fdCount\":"); number_or_null(value.fdValid, value.fd);
        append(",\"sampleErrors\":{\"taskInfo\":%d,\"descriptors\":%d,\"identity\":%d}}", value.taskError, value.fdError, value.identityError);
    }
    append("]"); return observed;
}
static void emit_observed_coverage(ObservedCoverage observed) {
    append("{\"processes\":%" PRIu64 ",\"rssSamples\":%" PRIu64
           ",\"cpuSamples\":%" PRIu64 ",\"fdSamples\":%" PRIu64 ",\"complete\":%s}",
           observed.processes, observed.rss, observed.cpu, observed.fd,
           observed.processes == observed.rss && observed.processes == observed.cpu &&
           observed.processes == observed.fd ? "true" : "false");
}
static void resources(bool refresh) {
    if (refresh) enumerate();
    classify();
    append("{\"type\":\"resources\",\"atMs\":%.3f,\"monotonicMs\":%.3f,\"app\":",
           wall_ms(), (double)monotonic_ns() / 1e6);
    ObservedCoverage observedApp = emit_processes(APP);
    append(",\"development\":");
    ObservedCoverage observedDevelopment = emit_processes(DEVELOPMENT);
    append(",\"associated\":");
    ObservedCoverage observedAssociated = emit_associated();
    append(",\"coverage\":{\"interval\":\"sincePreviousResources\","
           "\"scope\":\"observedProcessesOnly\",\"treeScanIntervalMs\":1000,"
           "\"lifecycleSampleIntervalMs\":10,\"unobservedShortProcessesPossible\":true,"
           "\"systemPids\":%" PRIu64 ",\"systemIdentified\":%" PRIu64 ","
           "\"resourceProcesses\":%" PRIu64 ",\"rssSamples\":%" PRIu64 ","
           "\"cpuSamples\":%" PRIu64 ",\"fdSamples\":%" PRIu64 ","
           "\"lifecycleSamples\":%" PRIu64 ",\"missedLifecycles\":%" PRIu64 ","
           "\"apiAttempts\":%" PRIu64 ",\"permissionDenied\":%" PRIu64 ","
           "\"noSuchProcess\":%" PRIu64 ",\"otherErrors\":%" PRIu64 ","
           "\"identityChanges\":%" PRIu64 ",\"complete\":%s,\"observedApp\":",
           coverage.systemPids, coverage.systemIdentified, coverage.resourceProcesses,
           coverage.rssSamples, coverage.cpuSamples, coverage.fdSamples,
           coverage.lifecycleSamples, coverage.missedLifecycles, coverage.attempts,
           coverage.denied, coverage.vanished, coverage.other, coverage.identityChanges,
           coverage.denied || coverage.vanished || coverage.other || coverage.identityChanges ||
           coverage.missedLifecycles ? "false" : "true");
    emit_observed_coverage(observedApp);
    append(",\"observedDevelopment\":");
    emit_observed_coverage(observedDevelopment);
    append(",\"observedAssociated\":");
    emit_observed_coverage(observedAssociated);
    append("}}\n");
    flush_output();
    memset(&coverage, 0, sizeof(coverage));
}
static void finish_track(size_t index) {
    Track *track = &tracked[index];
    bool missed = track->samples == 0;
    coverage.missedLifecycles += missed;
    append("{\"type\":\"lifecycle\",\"pid\":%d,\"ppid\":%d,\"startId\":",
           track->id.pid, track->parent);
    if (track->id.sec || track->id.usec)
        append("\"%" PRIu64 ":%06" PRIu64 "\"", track->id.sec, track->id.usec);
    else append("null");
    append(",\"atMs\":%.3f,\"samples\":%" PRIu64 ",\"maxRssBytes\":", wall_ms(), track->samples);
    number_or_null(track->rssValid, track->maxRss);
    append(",\"cpuNs\":"); number_or_null(track->cpuValid, track->cpu);
    append(",\"fdCount\":"); number_or_null(track->fdValid, track->fd);
    append(",\"missed\":%s,\"incomplete\":%s}\n", missed ? "true" : "false",
           track->incomplete ? "true" : "false");
    flush_output();
    tracked[index] = tracked[--trackedCount];
}
static bool sample_track(size_t index) {
    Track *track = &tracked[index];
    Measurement value = measure(track->id);
    if (!value.present) {
        track->incomplete = true;
        struct proc_bsdinfo bsd;
        errno = 0;
        bool exists = read_bsd(track->id.pid, &bsd);
        int error = errno;
        if ((exists && !equal_id(track->id, identity(&bsd))) ||
            (!exists && (error == ESRCH || error == ENOENT))) {
            finish_track(index);
            return false;
        }
        return true;
    }
    track->samples++;
    coverage.lifecycleSamples++;
    if (value.rssValid) {
        if (!track->rssValid || value.rss > track->maxRss) track->maxRss = value.rss;
        track->rssValid = true;
    }
    if (value.cpuValid) { track->cpu = value.cpu; track->cpuValid = true; }
    if (value.fdValid) { track->fd = value.fd; track->fdValid = true; }
    else track->incomplete = true;
    return true;
}
static pid_t parse_pid(const char **cursor) {
    const char *text = *cursor;
    if (*text < '1' || *text > '9') fail("PID must be a positive decimal integer");
    uint64_t value = 0;
    do {
        value = value * 10 + (unsigned)(*text++ - '0');
        if (value > INT_MAX) fail("PID out of range");
    } while (*text >= '0' && *text <= '9');
    *cursor = text;
    return (pid_t)value;
}
static void configure(pid_t appPid, pid_t launcherPid) {
    if (configured || appPid == launcherPid || appPid == selfPid || launcherPid == selfPid ||
        appPid == ownerPid || launcherPid == ownerPid)
        fail("invalid or repeated roots");
    require_owner();
    enumerate();
    if (!descends_from(launcherPid, ownerPid) || !descends_from(appPid, launcherPid))
        fail("roots are not owned descendants of this runner");
    remember(identity(&find_node(appPid)->bsd), APP);
    remember(identity(&find_node(launcherPid)->bsd), DEVELOPMENT);
    configured = true;
    resources(false);
}
static void start_track(pid_t pid, pid_t parent) {
    if (pid == parent || pid == selfPid) fail("invalid tracked PID");
    for (size_t i = 0; i < trackedCount; i++) {
        if (tracked[i].id.pid != pid) continue;
        struct proc_bsdinfo current;
        if (!read_bsd(pid, &current) || equal_id(tracked[i].id, identity(&current)))
            fail("duplicate active track");
        coverage.identityChanges++;
        tracked[i].incomplete = true;
        finish_track(i);
        break;
    }
    Known *owner = find_known(parent);
    if (!owner) fail("tracked parent is outside the measured trees");
    unsigned group = owner->group;
    Identity ownerId = owner->id;
    struct proc_bsdinfo parentInfo;
    if (!read_bsd(parent, &parentInfo) || !equal_id(ownerId, identity(&parentInfo)))
        fail("tracked parent identity unavailable or changed");
    if (trackedCount == MAX_TRACKED) fail("tracked process limit exceeded");
    size_t index = trackedCount++;
    tracked[index] = (Track){ .id = { .pid = pid }, .parent = parent };
    struct proc_bsdinfo child;
    if (!read_bsd(pid, &child)) {
        tracked[index].incomplete = true;
        finish_track(index);
        return;
    }
    /* A verified descendant may exec a setuid system tool; effective UID is
     * not ancestry. The parent and both birth identities establish ownership. */
    if (child.pbi_ppid != (uint32_t)parent || !older_or_equal(ownerId, identity(&child)))
        fail("tracked child ownership mismatch");
    if (!read_bsd(parent, &parentInfo) || !equal_id(ownerId, identity(&parentInfo)))
        fail("tracked parent identity changed during admission");
    tracked[index].id = identity(&child);
    remember(tracked[index].id, group);
    (void)sample_track(index);
}
static uint64_t association_number(const char **cursor, uint64_t maximum) {
    const char *text = *cursor;
    if (*text < '0' || *text > '9') fail("invalid association identity");
    uint64_t value = 0;
    do {
        unsigned digit = (unsigned)(*text++ - '0');
        if (value > (maximum - digit) / 10) fail("association identity out of range");
        value = value * 10 + digit;
    } while (*text >= '0' && *text <= '9');
    *cursor = text; return value;
}
static bool command(const char *line) {
    require_owner();
    if (strcmp(line, "stop") == 0) return false;
    if (!strcmp(line, "xpc-reset")) { if (!configured) fail("XPC before roots"); associatedCount = 0; return true; }
    if (!strncmp(line, "xpc ", 4)) {
        if (!configured || associatedCount == 16) fail("XPC association budget");
        const char *cursor = line + 4;
        pid_t pid = parse_pid(&cursor);
        if (*cursor++ != ' ') fail("missing XPC birth seconds");
        uint64_t sec = association_number(&cursor, UINT64_C(9007199254740991));
        if (*cursor++ != ' ') fail("missing XPC birth microseconds");
        uint64_t usec = association_number(&cursor, UINT64_C(999999));
        if (*cursor || !sec || pid == selfPid || pid == ownerPid) fail("invalid XPC identity");
        for (size_t i = 0; i < associatedCount; i++) if (associated[i].id.pid == pid) fail("duplicate XPC identity");
        associated[associatedCount++] = (Association){ .id = {pid, sec, usec}, .admitted = monotonic_ns() };
        return true;
    }
    bool roots = strncmp(line, "roots ", 6) == 0;
    bool track = strncmp(line, "track ", 6) == 0;
    bool exited = strncmp(line, "exit ", 5) == 0;
    if ((!roots && !track && !exited) || (!roots && !configured)) fail("invalid protocol command");
    const char *cursor = line + (exited ? 5 : 6);
    pid_t first = parse_pid(&cursor);
    if (exited) {
        if (*cursor) fail("unexpected exit arguments");
        for (size_t i = 0; i < trackedCount; i++) {
            if (tracked[i].id.pid == first) {
                if (sample_track(i)) finish_track(i);
                break;
            }
        }
        return true;
    }
    if (*cursor++ != ' ') fail("missing second PID");
    pid_t second = parse_pid(&cursor);
    if (*cursor) fail("unexpected protocol arguments");
    if (roots) configure(first, second); else start_track(first, second);
    return true;
}
static void connect_owner(const char *filename, const char *pidText, const char *nonce) {
    if (getuid() != 0 || geteuid() != 0) fail("admin socket mode requires administrator privileges");
    const char *cursor = pidText;
    ownerPid = parse_pid(&cursor);
    if (*cursor || ownerPid == selfPid || strlen(nonce) != 64) fail("invalid admin owner or nonce");
    for (size_t i = 0; i < 64; i++)
        if (!((nonce[i] >= '0' && nonce[i] <= '9') || (nonce[i] >= 'a' && nonce[i] <= 'f')))
            fail("invalid admin nonce");
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    size_t length = strlen(filename);
    if (filename[0] != '/' || length >= sizeof(address.sun_path)) fail("invalid admin socket path");
    memcpy(address.sun_path, filename, length + 1);
    address.sun_len = (uint8_t)(offsetof(struct sockaddr_un, sun_path) + length + 1);
    struct stat info;
    if (lstat(filename, &info) || !S_ISSOCK(info.st_mode) || info.st_uid == 0 || (info.st_mode & 0777) != 0600)
        fail("admin socket must be private and owned by an unprivileged user");
    int socketFd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (socketFd < 0 || fcntl(socketFd, F_SETFL, O_NONBLOCK) < 0) fail("cannot create admin connection");
    if (connect(socketFd, (struct sockaddr *)&address, address.sun_len) != 0) {
        if (errno != EINPROGRESS) fail("cannot connect to admin owner");
        struct pollfd wait = { .fd = socketFd, .events = POLLOUT };
        int error = 0; socklen_t size = sizeof(error);
        if (poll(&wait, 1, 3000) != 1 || getsockopt(socketFd, SOL_SOCKET, SO_ERROR, &error, &size) || error)
            fail("admin owner connection failed or timed out");
    }
    uid_t peerUid; gid_t peerGid; pid_t peerPid = 0;
    socklen_t size = sizeof(peerPid);
    if (getpeereid(socketFd, &peerUid, &peerGid) ||
        getsockopt(socketFd, SOL_LOCAL, LOCAL_PEERPID, &peerPid, &size) || size != sizeof(peerPid) ||
        peerUid == 0 || peerUid != info.st_uid || peerPid != ownerPid)
        fail("admin socket peer does not match the unprivileged owner");
    ownerUid = peerUid;
    struct proc_bsdinfo owner;
    if (!read_bsd(ownerPid, &owner) || owner.pbi_uid != ownerUid || owner.pbi_ruid != ownerUid)
        fail("admin owner credentials unavailable or changed");
    ownerIdentity = identity(&owner);
    for (int fd = STDIN_FILENO; fd <= STDERR_FILENO; fd++)
        if (dup2(socketFd, fd) < 0) fail("cannot bind admin protocol connection");
    if (socketFd > STDERR_FILENO && close(socketFd)) fail("cannot close admin connection descriptor");
}
int main(int argc, const char **argv) {
    selfPid = getpid();
    const char *nonce = NULL;
    if (argc == 5 && strcmp(argv[1], "--connect") == 0) {
        nonce = argv[4];
        connect_owner(argv[2], argv[3], nonce);
    } else if (argc == 1) {
        if (getuid() == 0 || geteuid() != getuid()) fail("stdio mode requires an unprivileged user");
        ownerPid = getppid(); ownerUid = getuid();
        struct proc_bsdinfo owner;
        if (!read_bsd(ownerPid, &owner)) fail("sampler owner unavailable");
        ownerIdentity = identity(&owner);
        require_owner();
    } else fail("usage: process-sampler [--connect SOCKET OWNER_PID NONCE]");
    if (mach_timebase_info(&timebase) != KERN_SUCCESS || !timebase.numer || !timebase.denom)
        fail("cannot obtain Mach clock timebase");
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = on_signal;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGINT, &action, NULL) || sigaction(SIGTERM, &action, NULL))
        fail("signal registration failed");
    action.sa_handler = SIG_IGN;
    if (sigaction(SIGPIPE, &action, NULL)) fail("SIGPIPE registration failed");
    int flags = fcntl(STDOUT_FILENO, F_GETFL);
    if (flags < 0 || fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK) < 0)
        fail("cannot set stdout nonblocking");
    append("{\"type\":\"sampler-ready\",\"pid\":%d,\"effectiveUid\":%u,\"ownerPid\":%d,\"ownerUid\":%u,\"nonce\":",
           selfPid, geteuid(), ownerPid, ownerUid);
    if (nonce) append("\"%s\"", nonce); else append("null");
    append("}\n");
    flush_output();
    char line[MAX_LINE];
    size_t lineSize = 0;
    uint64_t nextOwnerCheck = monotonic_ns();
    uint64_t nextResources = monotonic_ns() + UINT64_C(1000000000);
    uint64_t nextTrack = monotonic_ns() + UINT64_C(10000000);
    bool running = true;
    while (running && !interrupted) {
        uint64_t now = monotonic_ns();
        if (now >= nextOwnerCheck) {
            require_owner();
            nextOwnerCheck = now + UINT64_C(1000000000);
        }
        if (configured && now >= nextResources) {
            resources(true);
            nextResources = monotonic_ns() + UINT64_C(1000000000);
        }
        if (trackedCount && now >= nextTrack) {
            for (size_t i = 0; i < trackedCount && !interrupted;)
                if (sample_track(i)) i++;
            nextTrack = monotonic_ns() + UINT64_C(10000000);
        }
        now = monotonic_ns();
        uint64_t deadline = configured ? nextResources : now + UINT64_C(1000000000);
        if (trackedCount && nextTrack < deadline) deadline = nextTrack;
        int timeout = deadline <= now ? 0 : (int)((deadline - now + 999999) / 1000000);
        struct pollfd fd = { .fd = STDIN_FILENO, .events = POLLIN };
        int ready = poll(&fd, 1, timeout);
        if (ready < 0) { if (errno == EINTR) continue; fail("stdin poll failed"); }
        if (fd.revents & (POLLERR | POLLNVAL)) fail("stdin failed");
        if (ready > 0 && (fd.revents & (POLLIN | POLLHUP))) {
            char chunk[1024];
            ssize_t size = read(STDIN_FILENO, chunk, sizeof(chunk));
            if (size < 0) { if (errno == EINTR || errno == EAGAIN) continue; fail("stdin read failed"); }
            if (size == 0) fail("stdin closed without stop command");
            for (ssize_t i = 0; i < size; i++) {
                unsigned char c = (unsigned char)chunk[i];
                if (c == '\n') {
                    line[lineSize] = '\0';
                    running = command(line);
                    lineSize = 0;
                    if (!running) {
                        if (i + 1 != size) fail("input after stop command");
                        break;
                    }
                } else {
                    if (c < 0x20 || c > 0x7e) fail("non-ASCII protocol input");
                    if (lineSize == sizeof(line) - 1) fail("protocol line limit exceeded");
                    line[lineSize++] = (char)c;
                }
            }
        }
    }
    if (!interrupted) {
        while (trackedCount) {
            tracked[trackedCount - 1].incomplete = true;
            if (sample_track(trackedCount - 1)) finish_track(trackedCount - 1);
        }
        if (configured) resources(true);
    }
    return EXIT_SUCCESS;
}
