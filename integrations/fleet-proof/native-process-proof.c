/* macOS kernel facts for local fleet admission. No request claims grant authority. */
#if !defined(__APPLE__)
#error "Native local fleet proof requires macOS"
#endif

#include <arpa/inet.h>
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/sysctl.h>
#include <time.h>
#include <unistd.h>

enum { MAX_PIDS = 16384, MAX_FDS = 16384, MAX_CHAIN = 64, MAX_SCAN_MS = 200,
       MAX_ATTEMPTS = 3, MAX_TOTAL_MS = MAX_SCAN_MS * MAX_ATTEMPTS };
_Static_assert(sizeof(pid_t) == 4 && sizeof(uid_t) == 4, "Unsupported process ABI");
_Static_assert(sizeof(struct proc_bsdinfo) == 136, "Unsupported proc_bsdinfo ABI");
_Static_assert(offsetof(struct proc_bsdinfo, pbi_start_tvsec) == 120, "Unsupported birth ABI");
_Static_assert(offsetof(struct proc_bsdinfo, pbi_start_tvusec) == 128, "Unsupported birth ABI");

struct identity {
  pid_t pid;
  pid_t ppid;
  uid_t uid;
  uid_t ruid;
  uint64_t sec;
  uint64_t usec;
};
struct owner {
  struct identity process;
  int fd;
  uint64_t socket;
  uint64_t pcb;
  uint64_t generation;
};
enum { MAX_ARG_BLOB = 1024 * 1024, MAX_HEAD_ARG = 4096 };
struct process_record {
  struct identity process;
  char executable[PROC_PIDPATHINFO_MAXSIZE];
  char argv[2][MAX_HEAD_ARG + 1];
  int argc;
};
static struct timespec began;
static struct timespec overall_began;
static int diagnostics;
static int current_attempt;
static int budget_reported;
static int budget_expired;

/* Fixed vocabulary only: this observation is never an admission input. */
static void diagnostic(const char *stage, const char *reason, int error, int retry) {
  if (!diagnostics) return;
  int saved_error = errno;
  fprintf(stderr, "Native process proof diagnostic: {\"schemaVersion\":1,"
          "\"stage\":\"%s\",\"reason\":\"%s\",\"errno\":%d,"
          "\"attempt\":%d,\"retry\":%s}\n", stage, reason, error < 0 ? 0 : error,
          current_attempt, retry ? "true" : "false");
  errno = saved_error;
}

static int refuse(void) {
  return budget_expired ? 2 : 1;
}

static int final_refusal(void) {
  fputs("Native process proof unavailable\n", stderr);
  return 1;
}

static int refuse_at(const char *stage, const char *reason, int error) {
  diagnostic(stage, reason, error, budget_expired);
  return refuse();
}

static int within_budget(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
    diagnostic("startup", "clock_unavailable", errno, 0);
    return 0;
  }
  int64_t ns = (int64_t)(now.tv_sec - began.tv_sec) * INT64_C(1000000000) +
               now.tv_nsec - began.tv_nsec;
  int64_t total_ns = (int64_t)(now.tv_sec - overall_began.tv_sec) * INT64_C(1000000000) +
                     now.tv_nsec - overall_began.tv_nsec;
  int valid = ns >= 0 && total_ns >= 0 && ns < (int64_t)MAX_SCAN_MS * 1000000 &&
              total_ns < (int64_t)MAX_TOTAL_MS * 1000000;
  if (ns >= 0 && total_ns >= 0 && !valid) budget_expired = 1;
  if (!valid && !budget_reported) {
    budget_reported = 1;
    diagnostic("completion", "budget_exhausted", 0, budget_expired);
  }
  return valid;
}

static int within_overall_budget(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
    diagnostic("startup", "clock_unavailable", errno, 0);
    return 0;
  }
  int64_t ns = (int64_t)(now.tv_sec - overall_began.tv_sec) * INT64_C(1000000000) +
               now.tv_nsec - overall_began.tv_nsec;
  return ns >= 0 && ns < (int64_t)MAX_TOTAL_MS * 1000000;
}

static int decimal(const char *text, uint64_t max, uint64_t *out) {
  if (text == NULL || *text == '\0') return 0;
  for (const char *p = text; *p; ++p) if (*p < '0' || *p > '9') return 0;
  errno = 0;
  char *end = NULL;
  unsigned long long value = strtoull(text, &end, 10);
  if (errno != 0 || *end != '\0' || value > max) return 0;
  *out = (uint64_t)value;
  return 1;
}

/* A vanished PID is skippable only when the kernel confirms it has exited. */
static int exited(pid_t pid) {
  errno = 0;
  if (kill(pid, 0) == -1 && errno == ESRCH) return 1;
  /* Nonzero arg includes zombies; kill(0) alone still succeeds for them. */
  struct proc_bsdshortinfo b;
  return proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 1, &b, sizeof(b)) == sizeof(b) &&
         b.pbsi_pid == (uint32_t)pid && b.pbsi_status == SZOMB;
}

/* The short flavor is readable without the full snapshot's same-user
 * privilege. A setuid process's real UID never proves its effective UID. */
static int protected_other_user(pid_t pid) {
  struct proc_bsdshortinfo b;
  return proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 1, &b, sizeof(b)) == sizeof(b) &&
         b.pbsi_pid == (uint32_t)pid && b.pbsi_status != SZOMB &&
         b.pbsi_uid != getuid();
}

/* 1 = live identity, 0 = actually exited, -1 = inaccessible/invalid. */
static int observe(pid_t pid, struct identity *out) {
  struct proc_bsdinfo b;
  if (pid <= 1 || !within_budget()) { errno = EINVAL; return -1; }
  errno = 0;
  int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &b, sizeof(b));
  if (bytes != sizeof(b)) {
    int error = errno;
    if (exited(pid)) return 0;
    errno = error;
    return -1;
  }
  if (b.pbi_pid != (uint32_t)pid || b.pbi_start_tvsec == 0 ||
      b.pbi_start_tvusec >= 1000000 || b.pbi_ppid > INT_MAX) { errno = EPROTO; return -1; }
  if (b.pbi_status == SZOMB) return 0;
  *out = (struct identity){pid, (pid_t)b.pbi_ppid, b.pbi_uid, b.pbi_ruid,
                           b.pbi_start_tvsec, b.pbi_start_tvusec};
  return 1;
}

static int same_process(const struct identity *a, const struct identity *b) {
  return a->pid == b->pid && a->ppid == b->ppid && a->uid == b->uid &&
         a->ruid == b->ruid && a->sec == b->sec && a->usec == b->usec;
}

/* Parentage and birth are exported across users by the same kernel interface
 * used by ps. This never supplies the socket owner's admission identity. */
static int observe_ancestor(pid_t pid, struct identity *out) {
  if (pid <= 1 || !within_budget()) { errno = EINVAL; return -1; }
  int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  struct kinfo_proc k;
  size_t bytes = sizeof(k);
  errno = 0;
  if (sysctl(mib, 4, &k, &bytes, NULL, 0) != 0 || bytes != sizeof(k)) return -1;
  if (k.kp_proc.p_pid != pid || k.kp_eproc.e_ppid < 0 ||
      k.kp_proc.p_starttime.tv_sec <= 0 || k.kp_proc.p_starttime.tv_usec < 0 ||
      k.kp_proc.p_starttime.tv_usec >= 1000000) { errno = EPROTO; return -1; }
  if (k.kp_proc.p_stat == SZOMB || (k.kp_proc.p_flag & P_WEXIT)) return 0;
  *out = (struct identity){pid, k.kp_eproc.e_ppid, k.kp_eproc.e_ucred.cr_uid,
                           k.kp_eproc.e_pcred.p_ruid,
                           (uint64_t)k.kp_proc.p_starttime.tv_sec,
                           (uint64_t)k.kp_proc.p_starttime.tv_usec};
  return 1;
}


static int compare_pid(const void *a, const void *b) {
  pid_t aa = *(const pid_t *)a, bb = *(const pid_t *)b;
  return (aa > bb) - (aa < bb);
}

static int list_pids(uint32_t kind, pid_t *out, int *count) {
  if (!within_budget()) return 0;
  errno = 0;
  int bytes = proc_listpids(kind, kind == PROC_ALL_PIDS ? 0 : getuid(),
                            out, MAX_PIDS * (int)sizeof(*out));
  if (bytes <= 0 || bytes >= MAX_PIDS * (int)sizeof(*out) || bytes % sizeof(*out)) return 0;
  *count = bytes / (int)sizeof(*out);
  qsort(out, (size_t)*count, sizeof(*out), compare_pid);
  return 1;
}

static int contains(const pid_t *pids, int count, pid_t pid) {
  return bsearch(&pid, pids, (size_t)count, sizeof(pid), compare_pid) != NULL;
}

static int socket_info(pid_t pid, int fd, struct socket_fdinfo *out) {
  return within_budget() &&
         proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO, out, sizeof(*out)) == sizeof(*out);
}

static int matches(const struct socket_fdinfo *s, uint16_t client, uint16_t server) {
  if (s->psi.soi_family != AF_INET || s->psi.soi_type != SOCK_STREAM ||
      s->psi.soi_kind != SOCKINFO_TCP || s->psi.soi_protocol != IPPROTO_TCP) return 0;
  const struct tcp_sockinfo *tcp = &s->psi.soi_proto.pri_tcp;
  const struct in_sockinfo *ip = &tcp->tcpsi_ini;
  return tcp->tcpsi_state == TSI_S_ESTABLISHED && (ip->insi_vflag & INI_IPV4) &&
         ntohs((uint16_t)ip->insi_lport) == client &&
         ntohs((uint16_t)ip->insi_fport) == server &&
         ip->insi_laddr.ina_46.i46a_addr4.s_addr == htonl(INADDR_LOOPBACK) &&
         ip->insi_faddr.ina_46.i46a_addr4.s_addr == htonl(INADDR_LOOPBACK);
}

static int same_socket(const struct owner *owner, const struct socket_fdinfo *s) {
  return s->psi.soi_so == owner->socket && s->psi.soi_pcb == owner->pcb &&
         s->psi.soi_proto.pri_tcp.tcpsi_ini.insi_gencnt == owner->generation;
}

static void print_identity(const struct identity *p, int include_uid) {
  printf("{\"pid\":%d", p->pid);
  if (include_uid) printf(",\"uid\":%u", (unsigned)p->uid);
  else printf(",\"ppid\":%d", p->ppid);
  printf(",\"birth\":[\"%" PRIu64 "\",\"%" PRIu64 "\"]", p->sec, p->usec);
}

/* JSON only accepts Unicode scalar values, not arbitrary filesystem bytes. */
static int valid_utf8(const char *text, size_t length) {
  const unsigned char *p = (const unsigned char *)text;
  for (size_t i = 0; i < length;) {
    unsigned char first = p[i++];
    if (first < 0x80) continue;
    uint32_t scalar;
    int count;
    if (first >= 0xc2 && first <= 0xdf) { scalar = first & 0x1f; count = 1; }
    else if (first >= 0xe0 && first <= 0xef) { scalar = first & 0x0f; count = 2; }
    else if (first >= 0xf0 && first <= 0xf4) { scalar = first & 0x07; count = 3; }
    else return 0;
    if ((size_t)count > length - i) return 0;
    for (int j = 0; j < count; ++j) {
      unsigned char next = p[i++];
      if ((next & 0xc0) != 0x80) return 0;
      scalar = (scalar << 6) | (next & 0x3f);
    }
    if ((count == 2 && scalar < 0x800) || (count == 3 && scalar < 0x10000) ||
        (scalar >= 0xd800 && scalar <= 0xdfff) || scalar > 0x10ffff) return 0;
  }
  return 1;
}

static void print_string(const char *text) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)text; *p; ++p) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 0x20) printf("\\u%04x", (unsigned)*p);
    else putchar(*p);
  }
  putchar('"');
}

/* These are both observed owners, not ancestry candidates. Never substitute
 * KERN_PROC_PID for an unavailable full same-user BSD observation. */
static int target_identity(pid_t pid, struct identity *out) {
  if (!within_budget()) return refuse();
  struct proc_bsdinfo b;
  errno = 0;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &b, sizeof(b)) != sizeof(b))
    return refuse_at("process", "process_unavailable", errno);
  if (b.pbi_pid != (uint32_t)pid || b.pbi_ppid > INT_MAX ||
      b.pbi_start_tvsec == 0 || b.pbi_start_tvusec >= 1000000 ||
      b.pbi_status == SZOMB || (b.pbi_flags & PROC_FLAG_INEXIT))
    return refuse_at("process", "process_unavailable", 0);
  if (b.pbi_uid != getuid()) return refuse_at("socket_owner", "owner_mismatch", 0);
  /* KERN_PROCARGS2 does not expose pointer width. Its alignment below is
   * supported only when the full BSD snapshot confirms a 64-bit process. */
  if (!(b.pbi_flags & PROC_FLAG_LP64)) return refuse_at("argv", "argv_invalid", 0);
  *out = (struct identity){pid, (pid_t)b.pbi_ppid, b.pbi_uid, b.pbi_ruid,
                           b.pbi_start_tvsec, b.pbi_start_tvusec};
  return 0;
}

static int executable_path(pid_t pid, char *path, size_t capacity) {
  if (!within_budget()) return refuse();
  errno = 0;
  int length = proc_pidpath(pid, path, (uint32_t)capacity);
  if (length <= 0 || (size_t)length >= capacity ||
      strnlen(path, capacity) != (size_t)length || path[0] != '/' ||
      !valid_utf8(path, (size_t)length))
    return refuse_at("executable", "executable_unavailable", errno);
  return 0;
}

static int argument_head(pid_t pid, struct process_record *out) {
  if (!within_budget()) return refuse();
  int maximum;
  size_t maximum_size = sizeof(maximum);
  int limit_mib[] = {CTL_KERN, KERN_ARGMAX};
  errno = 0;
  if (sysctl(limit_mib, 2, &maximum, &maximum_size, NULL, 0) != 0 ||
      maximum_size != sizeof(maximum) || maximum <= 0 || maximum > MAX_ARG_BLOB)
    return refuse_at("argv", "argv_unavailable", errno);
  size_t capacity = (size_t)maximum + sizeof(int);
  int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t needed = 0;
  if (!within_budget()) return refuse();
  errno = 0;
  if (sysctl(mib, 3, NULL, &needed, NULL, 0) != 0)
    return refuse_at("argv", "argv_unavailable", errno);
  if (needed <= sizeof(int) || needed > capacity)
    return refuse_at("argv", "argv_invalid", 0);
  /* Smaller buffers can yield a legacy truncated tail rather than an error.
   * Read up to the kernel limit and reject a full/truncated or changed result. */
  char *blob = calloc(capacity, 1);
  if (blob == NULL) return refuse_at("argv", "allocation_failed", errno);
  size_t bytes = capacity;
  int result = 0;
  if (!within_budget()) { result = refuse(); goto finish; }
  errno = 0;
  if (sysctl(mib, 3, blob, &bytes, NULL, 0) != 0) {
    result = refuse_at("argv", "argv_unavailable", errno); goto finish;
  }
  if (bytes <= sizeof(int) || bytes >= capacity ||
      ((bytes + sizeof(int) - 1) & ~(sizeof(int) - 1)) != needed) {
    result = refuse_at("argv", "argv_invalid", 0); goto finish;
  }
  size_t after = 0;
  if (!within_budget()) { result = refuse(); goto finish; }
  errno = 0;
  if (sysctl(mib, 3, NULL, &after, NULL, 0) != 0) {
    result = refuse_at("argv", "argv_unavailable", errno); goto finish;
  }
  if (after != needed) { result = refuse_at("argv", "argv_changed", 0); goto finish; }
  int argc;
  memcpy(&argc, blob, sizeof(argc));
  if (argc < 0 || (size_t)argc > bytes - sizeof(int)) {
    result = refuse_at("argv", "argv_invalid", 0); goto finish;
  }
  size_t path_length = strnlen(blob + sizeof(int), bytes - sizeof(int));
  if (path_length == 0 || path_length >= PROC_PIDPATHINFO_MAXSIZE ||
      path_length == bytes - sizeof(int)) {
    result = refuse_at("argv", "argv_invalid", 0); goto finish;
  }
  /* XNU exec_extract_strings pads executable_path= + path to the target
   * pointer width. KERN_PROCARGS2 strips the 16-byte key, preserving alignment.
   * Calculate that padding: skipping arbitrary NULs would lose empty argv[0]. */
  size_t offset = sizeof(int) + ((path_length + 1 + 7) & ~(size_t)7);
  if (offset > bytes) { result = refuse_at("argv", "argv_invalid", 0); goto finish; }
  for (size_t i = sizeof(int) + path_length + 1; i < offset; ++i)
    if (blob[i] != '\0') { result = refuse_at("argv", "argv_invalid", 0); goto finish; }
  out->argc = argc > 2 ? 2 : argc;
  for (int i = 0; i < out->argc; ++i) {
    size_t length = strnlen(blob + offset, bytes - offset);
    if (length == bytes - offset || length > MAX_HEAD_ARG ||
        !valid_utf8(blob + offset, length)) {
      result = refuse_at("argv", "argv_invalid", 0); goto finish;
    }
    memcpy(out->argv[i], blob + offset, length + 1);
    offset += length + 1;
  }
finish:
  /* The syscall may return additional arguments/environment. They are never
   * parsed, emitted or logged, and the entire temporary buffer is erased. */
  for (size_t i = 0; i < capacity; ++i) ((volatile unsigned char *)blob)[i] = 0;
  free(blob);
  return result;
}

static int capture_process(pid_t pid, struct process_record *out) {
  int result = target_identity(pid, &out->process);
  if (result != 0) return result;
  result = executable_path(pid, out->executable, sizeof(out->executable));
  if (result != 0) return result;
  result = argument_head(pid, out);
  if (result != 0) return result;
  struct identity after;
  result = target_identity(pid, &after);
  if (result != 0) return result;
  if (!same_process(&out->process, &after)) return refuse_at("process", "process_changed", 0);
  return 0;
}

static int prove_processes(int argc, char **argv) {
  uint64_t pids[2];
  if (argc != 4 || !decimal(argv[2], INT_MAX, &pids[0]) || pids[0] <= 1 ||
      !decimal(argv[3], INT_MAX, &pids[1]) || pids[1] <= 1)
    return refuse_at("arguments", "invalid_arguments", 0);
  struct process_record first[2] = {0}, second[2] = {0};
  for (int i = 0; i < 2; ++i) {
    int result = capture_process((pid_t)pids[i], &first[i]);
    if (result != 0) return result;
  }
  for (int i = 0; i < 2; ++i) {
    int result = capture_process((pid_t)pids[i], &second[i]);
    if (result != 0) return result;
    if (!same_process(&first[i].process, &second[i].process))
      return refuse_at("process", "process_changed", 0);
    if (strcmp(first[i].executable, second[i].executable) != 0)
      return refuse_at("executable", "executable_changed", 0);
    if (first[i].argc != second[i].argc)
      return refuse_at("argv", "argv_changed", 0);
    for (int j = 0; j < first[i].argc; ++j)
      if (strcmp(first[i].argv[j], second[i].argv[j]) != 0)
        return refuse_at("argv", "argv_changed", 0);
  }
  for (int i = 0; i < 2; ++i) {
    struct identity after;
    int result = target_identity((pid_t)pids[i], &after);
    if (result != 0) return result;
    if (!same_process(&first[i].process, &after)) return refuse_at("process", "process_changed", 0);
  }
  if (!within_budget()) return refuse();
  printf("{\"schemaVersion\":1,\"processes\":[");
  for (int i = 0; i < 2; ++i) {
    if (i) putchar(',');
    print_identity(&first[i].process, 1);
    printf(",\"ppid\":%d,\"executable\":", first[i].process.ppid);
    print_string(first[i].executable);
    printf(",\"argv\":[");
    for (int j = 0; j < first[i].argc; ++j) {
      if (j) putchar(',');
      print_string(first[i].argv[j]);
    }
    printf("]}");
  }
  puts("]}");
  return 0;
}

/* Return 2 only for census churn or an expired attempt. Retrying starts the entire census again;
 * uncertain records are never omitted from an otherwise successful proof. */
static int prove(int argc, char **argv) {
  if (argc != 3 && argc != 6 && argc != 7)
    return refuse_at("arguments", "invalid_arguments", 0);
  uint64_t client, server, expected_pid = 0, expected_sec = 0, expected_usec = 0;
  if (!decimal(argv[1], 65535, &client) || !decimal(argv[2], 65535, &server) ||
      client == 0 || server == 0 || client == server)
    return refuse_at("arguments", "invalid_arguments", 0);
  if (argc >= 6 && (!decimal(argv[3], INT_MAX, &expected_pid) || expected_pid <= 1 ||
                    !decimal(argv[4], UINT64_MAX, &expected_sec) || expected_sec == 0 ||
                    !decimal(argv[5], 999999, &expected_usec)))
    return refuse_at("arguments", "invalid_arguments", 0);

  pid_t all[MAX_PIDS], uid_pids[MAX_PIDS], ruid_pids[MAX_PIDS];
  int count, uid_count, ruid_count;
  if (!list_pids(PROC_ALL_PIDS, all, &count) ||
      !list_pids(PROC_UID_ONLY, uid_pids, &uid_count) ||
      !list_pids(PROC_RUID_ONLY, ruid_pids, &ruid_count))
    return refuse_at("census", "process_census_unavailable", errno);
  /* A same-user process born between these snapshots must not hide an owner. */
  for (int i = 0; i < uid_count; ++i)
    if (uid_pids[i] > 1 && !contains(all, count, uid_pids[i]) && !exited(uid_pids[i])) {
      diagnostic("census", "process_census_changed", 0, 1);
      return 2;
    }
  for (int i = 0; i < ruid_count; ++i)
    if (ruid_pids[i] > 1 && !contains(all, count, ruid_pids[i]) && !exited(ruid_pids[i])) {
      diagnostic("census", "process_census_changed", 0, 1);
      return 2;
    }

  struct proc_fdinfo *fds = calloc(MAX_FDS, sizeof(*fds));
  if (fds == NULL) return refuse_at("fd_list", "allocation_failed", errno);
  struct owner owner = {0};
  int valid = 1;
  for (int i = 0; valid == 1 && i < count; ++i) {
    pid_t pid = all[i];
    if (pid <= 1) continue;
    int same_uid = contains(uid_pids, uid_count, pid) || contains(ruid_pids, ruid_count, pid);
    struct identity before, after;
    int observed = observe(pid, &before);
    if (observed == 0) continue;
    if (observed < 0) {
      int observation_error = errno;
      /* libproc cannot inspect another user's protected processes. A same-user
       * denial is never treated as proof that the process owns no socket. */
      if ((errno == EPERM || errno == EACCES) && protected_other_user(pid)) continue;
      valid = errno == ESRCH ? -1 : 0;
      diagnostic("process", "process_unavailable", observation_error, valid == -1);
      break;
    }
    same_uid = same_uid || before.uid == getuid() || before.ruid == getuid();
    errno = 0;
    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, MAX_FDS * (int)sizeof(*fds));
    int error = errno;
    if (bytes < 0 || (bytes == 0 && error != 0)) {
      if (exited(pid)) continue;
      if (!same_uid && (error == EPERM || error == EACCES)) continue;
      valid = error == ESRCH ? -1 : 0;
      diagnostic("fd_list", "fd_list_unavailable", error, valid == -1);
      break;
    }
    if (bytes >= MAX_FDS * (int)sizeof(*fds) || bytes % sizeof(*fds)) {
      diagnostic("fd_list", "fd_list_bounds", 0, 0);
      valid = 0;
      break;
    }
    int found = 0;
    for (int j = 0; valid == 1 && j < bytes / (int)sizeof(*fds); ++j) {
      if (fds[j].proc_fd < 0) {
        diagnostic("fd_list", "fd_record_invalid", 0, 0);
        valid = 0;
        break;
      }
      if (fds[j].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
      struct socket_fdinfo socket;
      if (!socket_info(pid, fds[j].proc_fd, &socket)) {
        error = errno;
        if (exited(pid)) { found = 0; break; }
        if (!same_uid && (error == EPERM || error == EACCES)) continue;
        /* The kernel may have closed/replaced this descriptor since LISTFDS.
         * Start over on a stale-descriptor error; other failures stay closed. */
        valid = error == ESRCH || error == EBADF || error == ENOENT || error == ENOTSOCK ? -1 : 0;
        diagnostic("fd_socket", "socket_unavailable", error, valid == -1);
        break;
      }
      if (!matches(&socket, (uint16_t)client, (uint16_t)server)) continue;
      if (before.uid != getuid()) {
        diagnostic("socket_owner", "owner_mismatch", 0, 0);
        valid = 0;
        break;
      }
      if (socket.psi.soi_so == 0 || socket.psi.soi_pcb == 0 ||
          socket.psi.soi_proto.pri_tcp.tcpsi_ini.insi_gencnt == 0) {
        diagnostic("socket_owner", "socket_identity_invalid", 0, 0);
        valid = 0;
        break;
      }
      if (owner.process.pid != 0 && (owner.process.pid != pid || !same_socket(&owner, &socket))) {
        diagnostic("socket_owner", "multiple_owners", 0, 0);
        valid = 0;
        break;
      }
      owner = (struct owner){before, fds[j].proc_fd, socket.psi.soi_so, socket.psi.soi_pcb,
                            socket.psi.soi_proto.pri_tcp.tcpsi_ini.insi_gencnt};
      found = 1;
    }
    observed = observe(pid, &after);
    if (observed == 0 && !found) continue;
    if (observed != 1 || !same_process(&before, &after)) {
      diagnostic("process", "process_changed", observed == 1 ? 0 : errno, 1);
      valid = -1;
    }
  }
  free(fds);
  if (valid == -1 && within_budget()) return 2;
  if (!valid) return refuse();
  if (owner.process.pid <= 1) return refuse_at("socket_owner", "owner_not_found", 0);
  if (!within_budget()) return refuse_at("completion", "budget_exhausted", 0);

  if (argc >= 6 && ((uint64_t)owner.process.pid != expected_pid || owner.process.sec != expected_sec ||
                    owner.process.usec != expected_usec))
    return refuse_at("owner_pin", "owner_mismatch", 0);
  char socket_id[80];
  int length = snprintf(socket_id, sizeof(socket_id), "%" PRIu64 ":%" PRIu64 ":%" PRIu64,
                        owner.socket, owner.pcb, owner.generation);
  if (length < 0 || (size_t)length >= sizeof(socket_id) ||
      (argc == 7 && strcmp(socket_id, argv[6]) != 0))
    return refuse_at("owner_pin", "socket_mismatch", 0);

  struct identity chain[MAX_CHAIN];
  int chain_count = 0;
  pid_t current = owner.process.pid;
  while (current > 1) {
    if (chain_count >= MAX_CHAIN) return refuse_at("ancestry", "ancestry_bounds", 0);
    for (int i = 0; i < chain_count; ++i)
      if (chain[i].pid == current) return refuse_at("ancestry", "ancestry_cycle", 0);
    if ((chain_count == 0 ? observe(current, &chain[chain_count]) :
                           observe_ancestor(current, &chain[chain_count])) != 1)
      return refuse_at("ancestry", "ancestry_unavailable", errno);
    if (chain_count == 0 && !same_process(&owner.process, &chain[0]))
      return refuse_at("ancestry", "ancestry_changed", 0);
    current = chain[chain_count++].ppid;
  }
  for (int i = 0; i < chain_count; ++i) {
    struct identity after;
    if ((i == 0 ? observe(chain[i].pid, &after) : observe_ancestor(chain[i].pid, &after)) != 1 ||
        !same_process(&chain[i], &after))
      return refuse_at("ancestry", "ancestry_changed", errno);
  }
  struct socket_fdinfo final_socket;
  struct identity final_owner;
  if (!socket_info(owner.process.pid, owner.fd, &final_socket) ||
      !matches(&final_socket, (uint16_t)client, (uint16_t)server) ||
      !same_socket(&owner, &final_socket) || observe(owner.process.pid, &final_owner) != 1 ||
      !same_process(&owner.process, &final_owner) || !within_budget())
    return refuse_at("final_socket", "socket_mismatch", errno);

  printf("{\"schemaVersion\":1,\"owner\":");
  print_identity(&owner.process, 1);
  printf(",\"socket\":\"%s\"},\"ancestors\":[", socket_id);
  for (int i = 0; i < chain_count; ++i) {
    if (i) putchar(',');
    print_identity(&chain[i], 0);
    putchar('}');
  }
  puts("]}");
  return 0;
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[argc - 1], "--diagnostics") == 0) {
    diagnostics = 1;
    --argc;
  }
  if (clock_gettime(CLOCK_MONOTONIC, &overall_began) != 0) {
    diagnostic("startup", "clock_unavailable", errno, 0);
    return final_refusal();
  }
  for (int attempt = 0; attempt < MAX_ATTEMPTS && within_overall_budget(); ++attempt) {
    current_attempt = attempt + 1;
    budget_reported = 0;
    budget_expired = 0;
    if (clock_gettime(CLOCK_MONOTONIC, &began) != 0) {
      diagnostic("startup", "clock_unavailable", errno, 0);
      return final_refusal();
    }
    int result = argc > 1 && strcmp(argv[1], "--processes") == 0 ?
                   prove_processes(argc, argv) : prove(argc, argv);
    if (result == 0) return 0;
    if (result != 2) return final_refusal();
  }
  diagnostic("completion", within_overall_budget() ? "attempts_exhausted" : "budget_exhausted", 0, 0);
  return final_refusal();
}
