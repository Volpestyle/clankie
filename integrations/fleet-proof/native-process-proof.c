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
#include <time.h>
#include <unistd.h>

enum { MAX_PIDS = 16384, MAX_FDS = 16384, MAX_CHAIN = 64, MAX_SCAN_MS = 200, MAX_ATTEMPTS = 3 };
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
static struct timespec began;

static int refuse(void) {
  fputs("Native process proof unavailable\n", stderr);
  return 1;
}

static int within_budget(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
  int64_t ns = (int64_t)(now.tv_sec - began.tv_sec) * INT64_C(1000000000) +
               now.tv_nsec - began.tv_nsec;
  return ns >= 0 && ns < (int64_t)MAX_SCAN_MS * 1000000;
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

/* Return 2 only for census churn. Retrying starts the entire census again;
 * uncertain records are never omitted from an otherwise successful proof. */
static int prove(int argc, char **argv) {
  if (argc != 3 && argc != 6 && argc != 7) return refuse();
  uint64_t client, server, expected_pid = 0, expected_sec = 0, expected_usec = 0;
  if (!decimal(argv[1], 65535, &client) || !decimal(argv[2], 65535, &server) ||
      client == 0 || server == 0 || client == server) return refuse();
  if (argc >= 6 && (!decimal(argv[3], INT_MAX, &expected_pid) || expected_pid <= 1 ||
                    !decimal(argv[4], UINT64_MAX, &expected_sec) || expected_sec == 0 ||
                    !decimal(argv[5], 999999, &expected_usec))) return refuse();

  pid_t all[MAX_PIDS], uid_pids[MAX_PIDS], ruid_pids[MAX_PIDS];
  int count, uid_count, ruid_count;
  if (!list_pids(PROC_ALL_PIDS, all, &count) ||
      !list_pids(PROC_UID_ONLY, uid_pids, &uid_count) ||
      !list_pids(PROC_RUID_ONLY, ruid_pids, &ruid_count)) return refuse();
  /* A same-user process born between these snapshots must not hide an owner. */
  for (int i = 0; i < uid_count; ++i)
    if (uid_pids[i] > 1 && !contains(all, count, uid_pids[i]) && !exited(uid_pids[i])) return 2;
  for (int i = 0; i < ruid_count; ++i)
    if (ruid_pids[i] > 1 && !contains(all, count, ruid_pids[i]) && !exited(ruid_pids[i])) return 2;

  struct proc_fdinfo *fds = calloc(MAX_FDS, sizeof(*fds));
  if (fds == NULL) return refuse();
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
      /* libproc cannot inspect another user's protected processes. A same-user
       * denial is never treated as proof that the process owns no socket. */
      if ((errno == EPERM || errno == EACCES) && protected_other_user(pid)) continue;
      valid = errno == ESRCH ? -1 : 0;
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
      break;
    }
    if (bytes >= MAX_FDS * (int)sizeof(*fds) || bytes % sizeof(*fds)) { valid = 0; break; }
    int found = 0;
    for (int j = 0; valid == 1 && j < bytes / (int)sizeof(*fds); ++j) {
      if (fds[j].proc_fd < 0) { valid = 0; break; }
      if (fds[j].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
      struct socket_fdinfo socket;
      if (!socket_info(pid, fds[j].proc_fd, &socket)) {
        error = errno;
        if (exited(pid)) { found = 0; break; }
        if (!same_uid && (error == EPERM || error == EACCES)) continue;
        /* The kernel may have closed/replaced this descriptor since LISTFDS.
         * Start over on a stale-descriptor error; other failures stay closed. */
        valid = error == ESRCH || error == EBADF || error == ENOENT ? -1 : 0;
        break;
      }
      if (!matches(&socket, (uint16_t)client, (uint16_t)server)) continue;
      if (socket.psi.soi_so == 0 || socket.psi.soi_pcb == 0 ||
          socket.psi.soi_proto.pri_tcp.tcpsi_ini.insi_gencnt == 0) { valid = 0; break; }
      if (owner.process.pid != 0 && (owner.process.pid != pid || !same_socket(&owner, &socket))) {
        valid = 0;
        break;
      }
      owner = (struct owner){before, fds[j].proc_fd, socket.psi.soi_so, socket.psi.soi_pcb,
                            socket.psi.soi_proto.pri_tcp.tcpsi_ini.insi_gencnt};
      found = 1;
    }
    observed = observe(pid, &after);
    if (observed == 0 && !found) continue;
    if (observed != 1 || !same_process(&before, &after)) valid = -1;
  }
  free(fds);
  if (valid == -1 && within_budget()) return 2;
  if (!valid || owner.process.pid <= 1 || !within_budget()) return refuse();

  if (argc >= 6 && ((uint64_t)owner.process.pid != expected_pid || owner.process.sec != expected_sec ||
                    owner.process.usec != expected_usec)) return refuse();
  char socket_id[80];
  int length = snprintf(socket_id, sizeof(socket_id), "%" PRIu64 ":%" PRIu64 ":%" PRIu64,
                        owner.socket, owner.pcb, owner.generation);
  if (length < 0 || (size_t)length >= sizeof(socket_id) ||
      (argc == 7 && strcmp(socket_id, argv[6]) != 0)) return refuse();

  struct identity chain[MAX_CHAIN];
  int chain_count = 0;
  pid_t current = owner.process.pid;
  while (current > 1) {
    if (chain_count >= MAX_CHAIN) return refuse();
    for (int i = 0; i < chain_count; ++i) if (chain[i].pid == current) return refuse();
    if (observe(current, &chain[chain_count]) != 1) return refuse();
    if (chain_count == 0 && !same_process(&owner.process, &chain[0])) return refuse();
    current = chain[chain_count++].ppid;
  }
  for (int i = 0; i < chain_count; ++i) {
    struct identity after;
    if (observe(chain[i].pid, &after) != 1 || !same_process(&chain[i], &after)) return refuse();
  }
  struct socket_fdinfo final_socket;
  struct identity final_owner;
  if (!socket_info(owner.process.pid, owner.fd, &final_socket) ||
      !matches(&final_socket, (uint16_t)client, (uint16_t)server) ||
      !same_socket(&owner, &final_socket) || observe(owner.process.pid, &final_owner) != 1 ||
      !same_process(&owner.process, &final_owner) || !within_budget()) return refuse();

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
  if (clock_gettime(CLOCK_MONOTONIC, &began) != 0) return refuse();
  for (int attempt = 0; attempt < MAX_ATTEMPTS && within_budget(); ++attempt) {
    int result = prove(argc, argv);
    if (result != 2) return result;
  }
  return refuse();
}
