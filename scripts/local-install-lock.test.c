// Test-only observer: use the SDK's struct flock, without a Python runtime or
// a hand-packed ABI. F_GETLK observes the other process's lock without waiting.
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char *argv[]) {
    if (argc != 2) {
        fprintf(stderr, "Usage: local-install-lock-test LOCK\n");
        return 1;
    }
    int descriptor = open(argv[1], O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    if (descriptor < 0) {
        perror("open gate lock");
        return 1;
    }
    struct flock lock = {0};
    lock.l_type = F_WRLCK;
    lock.l_whence = SEEK_SET;
    int result = fcntl(descriptor, F_GETLK, &lock);
    if (result < 0) perror("F_GETLK gate lock");
    int closed = close(descriptor);
    if (closed < 0) perror("close gate lock");
    if (result < 0 || closed < 0) return 1;

    // Only l_type is defined when no conflicting lock exists.
    if (lock.l_type == F_UNLCK) {
        if (puts("{\"unlocked\":true}") == EOF) return 1;
    } else if (printf("{\"pid\":%jd,\"write\":%s,\"start\":%jd,\"length\":%jd}\n",
                      (intmax_t)lock.l_pid, lock.l_type == F_WRLCK ? "true" : "false",
                      (intmax_t)lock.l_start, (intmax_t)lock.l_len) < 0) {
        return 1;
    }
    if (fflush(stdout) == EOF) {
        perror("publish gate lock observation");
        return 1;
    }
    return 0;
}
