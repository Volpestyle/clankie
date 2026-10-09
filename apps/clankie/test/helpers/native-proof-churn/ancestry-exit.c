/* Schedule only owned exits. Every process/socket/ancestry result is native.
 * The shipped helper contains no scheduling controls. */
#define __STDC_WANT_LIB_EXT1__ 1
#include <libproc.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <poll.h>

static int scheduled_sysctl(int *, u_int, void *, size_t *, void *, size_t);
static int scheduled_pidinfo(int, int, uint64_t, void *, int);
#define sysctl scheduled_sysctl
#define proc_pidinfo scheduled_pidinfo
#define main proof_main
#include "../../../../../integrations/fleet-proof/native-process-proof.c"
#undef main
#undef sysctl
#undef proc_pidinfo

static pid_t root, middle, leaf;
static int armed, fired, leaf_reads, caller_exit, twice, external;
static uint64_t root_sec, root_usec;
static char target_path[PATH_MAX];

static void exit_root(void) {
  if (external) {
    struct proc_bsdinfo b;
    if (proc_pidinfo(root, PROC_PIDTBSDINFO, 0, &b, sizeof(b)) != sizeof(b) ||
        b.pbi_pid != (uint32_t)root || b.pbi_uid != getuid() ||
        b.pbi_start_tvsec != root_sec || b.pbi_start_tvusec != root_usec) abort();
  }
  if (kill(root, SIGTERM)) abort();
  if (!external && waitpid(root, NULL, 0) != root) abort();
  /* Wait for actual kernel reparenting, never fabricate an ancestry result. */
  for (int i = 0; i < 1000; ++i) {
    struct proc_bsdinfo b;
    pid_t child = middle > 1 ? middle : leaf;
    if (proc_pidinfo(child, PROC_PIDTBSDINFO, 0, &b, sizeof(b)) == sizeof(b) && b.pbi_ppid == 1 && (!external || exited(root))) return;
    usleep(100);
  }
  abort();
}

static int scheduled_sysctl(int *mib, u_int count, void *out, size_t *size, void *in, size_t in_size) {
  if (external && !armed) {
    FILE *record = fopen(target_path, "r");
    if (record) {
      if (fscanf(record, "%d %" SCNu64 " %" SCNu64 " %d", &root, &root_sec, &root_usec, &leaf) == 4 &&
          root > 1 && leaf > 1 && root_sec > 0 && root_usec < 1000000) armed = 1;
      fclose(record);
    }
  }
  if (armed && !fired && count == 4 && mib[0] == CTL_KERN && mib[1] == KERN_PROC &&
      mib[2] == KERN_PROC_PID && mib[3] == root) {
    fired = 1;
    exit_root();
  } else if (armed && twice && fired == 1 && count == 4 && mib[0] == CTL_KERN &&
             mib[1] == KERN_PROC && mib[2] == KERN_PROC_PID && mib[3] == middle) {
    fired = 2;
    if (kill(middle, SIGTERM)) abort();
    for (int i = 0; i < 1000; ++i) {
      struct proc_bsdinfo b;
      if (proc_pidinfo(leaf, PROC_PIDTBSDINFO, 0, &b, sizeof(b)) == sizeof(b) && b.pbi_ppid == 1) break;
      usleep(100);
    }
  }
  int result = sysctl(mib, count, out, size, in, in_size);
  int error = errno;
  if (armed && fired && count == 4 && mib[0] == CTL_KERN && mib[1] == KERN_PROC &&
      mib[2] == KERN_PROC_PID && (mib[3] == root || (twice && mib[3] == middle))) {
    fprintf(proof_error, "Kernel ancestry read: {\"result\":%d,\"errno\":%d,\"bytes\":%zu}\n", result, error, *size);
  }
  errno = error;
  return result;
}

static int scheduled_pidinfo(int pid, int flavor, uint64_t arg, void *out, int size) {
  /* Two census observations precede the first ancestry observation. */
  if (armed && caller_exit && pid == leaf && flavor == PROC_PIDTBSDINFO && ++leaf_reads == 3) {
    fired = 1;
    if (kill(leaf, SIGTERM)) abort();
    for (int i = 0; i < 1000; ++i) {
      struct proc_bsdshortinfo b;
      if (proc_pidinfo(leaf, PROC_PIDT_SHORTBSDINFO, 1, &b, sizeof(b)) != sizeof(b) || b.pbsi_status == SZOMB) break;
      usleep(100);
    }
  }
  return proc_pidinfo(pid, flavor, arg, out, size);
}

struct ready { pid_t leaf, middle; uint16_t port; };
static void client(int server, int report, pid_t parent) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons((uint16_t)server);
  if (fd < 0 || connect(fd, (struct sockaddr *)&address, sizeof(address))) _exit(2);
  socklen_t size = sizeof(address);
  if (getsockname(fd, (struct sockaddr *)&address, &size)) _exit(3);
  struct ready ready = {getpid(), parent, ntohs(address.sin_port)};
  if (write(report, &ready, sizeof(ready)) != sizeof(ready)) _exit(4);
  close(report);
  sleep(10); /* Bounded even if the test crashes. */
  close(fd);
  _exit(0);
}

int main(int argc, char **argv) {
  if (argc == 9 && strcmp(argv[1], "--launch") == 0) {
    pid_t child = fork();
    if (child < 0) return 5;
    if (!child) { execv(argv[3], &argv[3]); _exit(6); }
    FILE *record = fopen(argv[2], "w");
    if (!record) { kill(child, SIGTERM); waitpid(child, NULL, 0); return 7; }
    fprintf(record, "{\"root\":%d,\"leaf\":%d}\n", getpid(), child);
    fclose(record);
    waitpid(child, NULL, 0);
    return 0;
  }
  if (argc != 2 || strcmp(argv[1], "--serve") == 0) {
    external = 1;
    if (snprintf(target_path, sizeof(target_path), "%s.target", argv[0]) >= (int)sizeof(target_path)) return 2;
    return proof_main(argc, argv);
  }
  twice = strcmp(argv[1], "twice") == 0;
  int direct = strcmp(argv[1], "direct") == 0;
  caller_exit = strcmp(argv[1], "caller") == 0;
  int stable = strcmp(argv[1], "live") == 0;
  int listener = socket(AF_INET, SOCK_STREAM, 0), report[2];
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  socklen_t size = sizeof(address);
  if (listener < 0 || bind(listener, (struct sockaddr *)&address, size) ||
      listen(listener, 1) || getsockname(listener, (struct sockaddr *)&address, &size) || pipe(report)) return 3;
  root = fork();
  if (root < 0) return 4;
  if (!root) {
    close(listener); close(report[0]);
    pid_t child = fork();
    if (child < 0) _exit(5);
    if (!child) {
      if (direct || caller_exit || stable) client(ntohs(address.sin_port), report[1], 0);
      pid_t owner = fork();
      if (owner < 0) _exit(6);
      if (!owner) client(ntohs(address.sin_port), report[1], getppid());
      close(report[1]); waitpid(owner, NULL, 0); _exit(0);
    }
    close(report[1]); waitpid(child, NULL, 0); _exit(0);
  }
  close(report[1]);
  struct ready ready;
  if (read(report[0], &ready, sizeof(ready)) != sizeof(ready)) abort();
  close(report[0]); leaf = ready.leaf; middle = ready.middle;
  int peer = accept(listener, NULL, NULL);
  if (peer < 0) abort();
  char client_port[16], server_port[16];
  snprintf(client_port, sizeof(client_port), "%u", ready.port);
  snprintf(server_port, sizeof(server_port), "%u", ntohs(address.sin_port));
  /* Keep the initial native facts for pins and pre-exit membership evidence. */
  char *args[] = {argv[0], client_port, server_port, "--diagnostics", NULL};
  int result = proof_main(4, args);
  if (result == 0) {
    armed = !stable;
    result = proof_main(4, args);
  }
  fprintf(stderr, "Owned ancestry scheduling: {\"fired\":%s,\"root\":%d,\"leaf\":%d,\"middle\":%d}\n",
          fired ? "true" : "false", root, leaf, middle);
  kill(leaf, SIGTERM);
  if (middle > 1) kill(middle, SIGTERM);
  if (!fired || caller_exit) { kill(root, SIGTERM); waitpid(root, NULL, 0); }
  close(peer); close(listener);
  return result;
}
