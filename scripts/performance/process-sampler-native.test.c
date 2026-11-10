#define main process_sampler_main
#include "process-sampler.c"
#undef main

static void check(bool condition, const char *message) {
    if (!condition) { fprintf(stderr, "%s\n", message); exit(EXIT_FAILURE); }
}
static Node fixture_node(pid_t pid, pid_t parent, uint64_t birth, bool valid) {
    Node node = { .pid = pid, .valid = valid };
    node.bsd.pbi_pid = (uint32_t)pid;
    node.bsd.pbi_ppid = (uint32_t)parent;
    node.bsd.pbi_start_tvsec = birth;
    node.bsd.pbi_uid = node.bsd.pbi_ruid = 501;
    return node;
}
static void fixture(bool parentValid, uint64_t parentBirth, uint64_t childBirth) {
    selfPid = 999;
    nodeCount = 2; knownCount = 0;
    memset(&coverage, 0, sizeof(coverage));
    nodes[0] = fixture_node(200, 1, parentBirth, parentValid);
    nodes[1] = fixture_node(300, 200, childBirth, true);
    remember((Identity){ .pid = 200, .sec = 2, .usec = 0 }, APP);
}
int main(void) {
    /* An unreadable PID may already belong to a replacement outside the tree.
     * Retain the old identity for explicit resource errors, never admit children. */
    fixture(false, 0, 4);
    classify();
    check(nodes[1].group == OUTSIDE && !find_known(300), "unreadable cached parent admitted a new child");
    check(knownCount == 1 && find_known(200)->id.sec == 2 && nodes[0].group == APP,
          "unreadable previously admitted identity was silently dropped");

    fixture(true, 3, 4);
    classify();
    check(nodes[0].group == OUTSIDE && nodes[1].group == OUTSIDE && knownCount == 0,
          "reused parent identity admitted an unrelated child");

    fixture(true, 2, 1);
    classify();
    check(nodes[1].group == OUTSIDE && !find_known(300), "child older than parent was admitted");

    fixture(true, 2, 4);
    nodes[1].bsd.pbi_uid = 0;
    classify();
    check(nodes[1].group == APP && find_known(300) && knownCount == 2,
          "verified descendant was rejected after setuid exec");

    nodes[0] = fixture_node(200, 1, 2, false);
    nodes[1] = fixture_node(300, 1, 4, true);
    classify();
    check(nodes[1].group == APP && find_known(300)->id.sec == 4,
          "previously admitted identity was lost on reparenting");
    /* Explicit XPC identities cannot authorize descendants or survive lease
     * expiry/PID reuse as valid resource observations. */
    knownCount = 0;
    associatedCount = 1;
    associated[0] = (Association){ .id = {getpid(), 1, 0}, .admitted = monotonic_ns() - UINT64_C(3000000000) };
    outputSize = 0;
    ObservedCoverage expired = emit_associated();
    output[outputSize] = 0;
    check(expired.processes == 1 && expired.rss == 0 && expired.cpu == 0 && expired.fd == 0,
          "expired XPC lease supplied resources");
    check(strstr(output, "\"rssBytes\":null") && strstr(output, "\"cpuNs\":null"), "missing XPC values were zero-filled");
    struct proc_bsdinfo live;
    check(read_bsd(getpid(), &live), "test process identity unavailable");
    associated[0].id = identity(&live); associated[0].id.sec++;
    associated[0].admitted = monotonic_ns(); outputSize = 0;
    ObservedCoverage reused = emit_associated();
    check(reused.rss == 0 && reused.cpu == 0 && reused.fd == 0, "reused XPC PID supplied resources");
    check(!find_known(getpid()), "explicit XPC association polluted ancestry authorization");
    puts("ancestry authorization boundaries passed");
    return EXIT_SUCCESS;
}
