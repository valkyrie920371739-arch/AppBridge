// Read-only, same-user Wine prefix process inventory for migration guards.
// macOS: clang -arch arm64 -mmacosx-version-min=14.0 -Wall -Wextra
//        -O2 native/appbridge-processes.c -o appbridge-processes
// The environment is inspected only for Wine/Windows-looking processes and is
// never emitted. stdout contains only pid, basename and classification.
#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <unistd.h>

#define MAX_PIDS 262144U
#define MAX_RESULTS 512U
#define MAX_ARGUMENT_BYTES (16U * 1024U * 1024U)
#define MAX_NAME_BYTES 255U

struct result { pid_t pid; char name[MAX_NAME_BYTES + 1]; const char *kind; };
struct arguments { const char *name; bool prefix_matches; };

static const char *base_name(const char *path) {
    const char *base = path;
    for (const char *p = path; *p; ++p) if (*p == '/' || *p == '\\') base = p + 1;
    return base;
}
static bool ends_exe(const char *name) {
    size_t length = strlen(name);
    return length >= 4 && strcasecmp(name + length - 4, ".exe") == 0;
}
static bool wine_loader(const char *name) {
    return strcasecmp(name, "wine") == 0 || strcasecmp(name, "wine64") == 0 ||
        strcasecmp(name, "wine-preloader") == 0 || strcasecmp(name, "wine64-preloader") == 0;
}
static bool wine_candidate(const char *name) {
    name = base_name(name);
    return wine_loader(name) || ends_exe(name) || strcasecmp(name, "wineserver") == 0;
}
static const char *classify(const char *name, const char *native_name) {
    if (strcasecmp(native_name, "wineserver") == 0) return "server";
    static const char *services[] = {"services.exe", "explorer.exe", "winedevice.exe", "svchost.exe", "plugplay.exe", "rpcss.exe"};
    for (size_t i = 0; i < sizeof(services) / sizeof(*services); ++i)
        if (strcasecmp(name, services[i]) == 0) return "service";
    return "application";
}
static void clear_buffer(char *buffer, size_t size) {
    volatile unsigned char *bytes = (volatile unsigned char *)buffer;
    while (size--) *bytes++ = 0;
}
static bool gone(pid_t pid) {
    if (kill(pid, 0) == 0) return false;
    return errno == ESRCH;
}
static bool same_process(const struct proc_bsdinfo *first, const struct proc_bsdinfo *last, uid_t uid) {
    return last->pbi_uid == uid && first->pbi_start_tvsec == last->pbi_start_tvsec &&
        first->pbi_start_tvusec == last->pbi_start_tvusec;
}
static bool next_string(const char **cursor, const char *end, const char **value) {
    if (*cursor >= end) return false;
    const char *zero = memchr(*cursor, '\0', (size_t)(end - *cursor));
    if (!zero) return false;
    *value = *cursor;
    *cursor = zero + 1;
    return true;
}
static bool prefix_equal(const char *value, const char *prefix) {
    if (value[0] != '/' || strlen(value) >= PATH_MAX) return false;
    if (strcmp(value, prefix) == 0) return true;
    char canonical[PATH_MAX];
    return realpath(value, canonical) && strcmp(canonical, prefix) == 0;
}
static bool parse_arguments(const char *buffer, size_t size, const char *prefix, struct arguments *out) {
    if (size < sizeof(int) + 2) return false;
    int count;
    memcpy(&count, buffer, sizeof(count));
    if (count < 1 || count > 65536) return false;
    const char *cursor = buffer + sizeof(count), *end = buffer + size, *value;
    if (!next_string(&cursor, end, &value)) return false; // executable path
    while (cursor < end && !*cursor) ++cursor; // kernel alignment before argv[0]
    if (cursor == end) return false;
    out->name = NULL;
    out->prefix_matches = false;
    for (int i = 0; i < count; ++i) {
        if (!next_string(&cursor, end, &value)) return false;
        const char *name = base_name(value);
        if (i == 0) out->name = name;
        if (ends_exe(name) && (!out->name || !ends_exe(out->name))) out->name = name;
    }
    // Rosetta/Wine may retain zero padding between the rewritten argv and env.
    while (cursor < end && !*cursor) ++cursor;
    bool prefix_seen = false;
    while (cursor < end && *cursor) {
        if (!next_string(&cursor, end, &value)) return false;
        if (strncmp(value, "WINEPREFIX=", 11) != 0) continue;
        // Duplicate environment keys are ambiguous; never call them safe.
        if (prefix_seen) return false;
        prefix_seen = true;
        out->prefix_matches = prefix_equal(value + 11, prefix);
    }
    return out->name && *out->name;
}
static void copy_name(char *out, const char *name) {
    name = base_name(name && *name ? name : "unreadable Wine process");
    size_t length = strlen(name);
    if (length > MAX_NAME_BYTES) {
        length = MAX_NAME_BYTES;
        // Avoid truncating a UTF-8 continuation sequence.
        while (length && (((unsigned char)name[length] & 0xc0) == 0x80)) --length;
    }
    memcpy(out, name, length);
    out[length] = '\0';
}
static bool append_result(struct result *results, size_t *count, pid_t pid, const char *name, const char *kind) {
    if (*count >= MAX_RESULTS) return false;
    results[*count].pid = pid;
    copy_name(results[*count].name, name);
    results[*count].kind = kind;
    ++*count;
    return true;
}
static void json_string(const char *value) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)value; *p; ++p) {
        if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
        else if (*p < 0x20 || *p == 0x7f) printf("\\u%04x", *p);
        else putchar(*p);
    }
    putchar('"');
}
static int fail(const char *message) {
    // Fixed messages only; never print a process environment or argument buffer.
    fprintf(stderr, "%s\n", message);
    return 2;
}
#ifndef APPBRIDGE_PROCESSES_NO_MAIN
int main(int argc, char **argv) {
    if (argc != 3 || strcmp(argv[1], "--prefix") || argv[2][0] != '/' || strlen(argv[2]) >= PATH_MAX)
        return fail("Expected --prefix and an absolute directory path.");
    char prefix[PATH_MAX];
    struct stat prefix_stat;
    if (!realpath(argv[2], prefix) || strcmp(prefix, "/") == 0 || stat(prefix, &prefix_stat) || !S_ISDIR(prefix_stat.st_mode))
        return fail("Prefix must be an existing non-root directory.");
    uid_t uid = getuid();
    if (geteuid() != uid) return fail("Process inventory must run without elevated privileges.");
    int needed = proc_listpids(PROC_UID_ONLY, uid, NULL, 0);
    if (needed <= 0 || (unsigned)needed > MAX_PIDS * sizeof(pid_t)) return fail("Cannot enumerate user processes.");
    pid_t *pids = NULL;
    int received = 0;
    for (int attempt = 0; attempt < 4; ++attempt) {
        size_t capacity = (size_t)needed + 256U * sizeof(pid_t);
        if (capacity > MAX_PIDS * sizeof(pid_t)) capacity = MAX_PIDS * sizeof(pid_t);
        pid_t *resized = realloc(pids, capacity);
        if (!resized) { free(pids); return fail("Cannot allocate process inventory."); }
        pids = resized;
        received = proc_listpids(PROC_UID_ONLY, uid, pids, (int)capacity);
        if (received <= 0) { free(pids); return fail("Cannot read user process inventory."); }
        if ((size_t)received < capacity) break;
        needed = (int)capacity;
        if (attempt == 3) { free(pids); return fail("User process inventory changed too quickly."); }
    }
    if (received % sizeof(pid_t)) { free(pids); return fail("Invalid user process inventory."); }
    int argument_max = 0;
    size_t argument_size = sizeof(argument_max);
    int argument_mib[] = {CTL_KERN, KERN_ARGMAX};
    if (sysctl(argument_mib, 2, &argument_max, &argument_size, NULL, 0) || argument_max < 4096 ||
        (unsigned)argument_max > MAX_ARGUMENT_BYTES) { free(pids); return fail("Cannot determine argument buffer bounds."); }
    char *buffer = malloc((size_t)argument_max);
    struct result *results = calloc(MAX_RESULTS, sizeof(*results));
    if (!buffer || !results) { free(buffer); free(results); free(pids); return fail("Cannot allocate bounded argument inventory."); }
    size_t result_count = 0;
    bool complete = true;
    for (size_t i = 0; i < (size_t)received / sizeof(pid_t) && complete; ++i) {
        pid_t pid = pids[i];
        if (pid <= 0 || pid == getpid()) continue;
        struct proc_bsdinfo before = {0}, after = {0};
        errno = 0;
        int bsd_size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before));
        if (bsd_size != sizeof(before)) {
            if (errno == ESRCH || gone(pid)) continue;
            char native_path[PROC_PIDPATHINFO_MAXSIZE] = {0};
            int path_size = proc_pidpath(pid, native_path, sizeof(native_path));
            if (path_size > 0 && !wine_candidate(native_path)) continue;
            complete = append_result(results, &result_count, pid, path_size > 0 ? native_path : "unreadable user process", "unknown");
            continue;
        }
        if (before.pbi_uid != uid) continue;
        before.pbi_name[sizeof(before.pbi_name) - 1] = '\0';
        before.pbi_comm[sizeof(before.pbi_comm) - 1] = '\0';
        char native_path[PROC_PIDPATHINFO_MAXSIZE] = {0};
        int path_size = proc_pidpath(pid, native_path, sizeof(native_path));
        const char *native_name = path_size > 0 ? base_name(native_path) : before.pbi_name;
        if (!wine_candidate(native_name) && !wine_candidate(before.pbi_name) && !wine_candidate(before.pbi_comm)) continue;
        if (path_size <= 0) {
            if (errno == ESRCH) continue;
            if (!gone(pid)) complete = append_result(results, &result_count, pid, native_name, "unknown");
            continue;
        }
        size_t size = (size_t)argument_max;
        int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
        if (sysctl(mib, 3, buffer, &size, NULL, 0)) {
            if (errno != ESRCH && !gone(pid)) complete = append_result(results, &result_count, pid, native_name, "unknown");
            continue;
        }
        struct arguments arguments;
        bool valid = size <= (size_t)argument_max && parse_arguments(buffer, size, prefix, &arguments);
        errno = 0;
        int after_size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after));
        if (after_size != sizeof(after) && errno == ESRCH) {
            clear_buffer(buffer, size <= (size_t)argument_max ? size : (size_t)argument_max);
            continue;
        }
        if (after_size != sizeof(after) || !same_process(&before, &after, uid)) {
            if (!gone(pid)) complete = append_result(results, &result_count, pid, native_name, "unknown");
        } else if (!valid) {
            complete = append_result(results, &result_count, pid, native_name, "unknown");
        } else if (arguments.prefix_matches) {
            complete = append_result(results, &result_count, pid, arguments.name, classify(arguments.name, native_name));
        }
        clear_buffer(buffer, size <= (size_t)argument_max ? size : (size_t)argument_max);
    }
    clear_buffer(buffer, (size_t)argument_max);
    free(buffer); free(pids);
    if (!complete) { free(results); return fail("Too many matching Wine processes to report safely."); }
    putchar('[');
    for (size_t i = 0; i < result_count; ++i) {
        if (i) putchar(',');
        printf("{\"pid\":%d,\"name\":", results[i].pid); json_string(results[i].name);
        printf(",\"kind\":\"%s\"}", results[i].kind);
    }
    puts("]");
    free(results);
    return ferror(stdout) ? 2 : 0;
}
#endif
