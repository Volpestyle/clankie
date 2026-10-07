/* Schedule real kernel churn at production libproc boundaries. The wrappers
 * only coordinate owned children; every observation/result comes from libproc.
 * Compile this fixture separately: the shipped helper has no test controls. */
#define __STDC_WANT_LIB_EXT1__ 1
#include <errno.h>
#include <libproc.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

static int scheduled_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int size);
static int scheduled_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size);
static int scheduled_pidfdinfo(int pid, int fd, int flavor, void *buffer, int size);
#define proc_listpids scheduled_listpids
#define proc_pidinfo scheduled_pidinfo
#define proc_pidfdinfo scheduled_pidfdinfo
#define main proof_main
#ifndef FLEET_PROOF_SOURCE
#define FLEET_PROOF_SOURCE "../../../../../integrations/fleet-proof/native-process-proof.c"
#endif
#include FLEET_PROOF_SOURCE
#undef main
#undef proc_pidinfo
#undef proc_pidfdinfo
#undef proc_listpids

static int census_churn, exit_churn, handoff_churn, handoff_done, child_matched;
static uint16_t target_client, target_server;
static char observation_path[PATH_MAX];
static pid_t child_pid;
static int child_fd;
static int commands = -1, replies = -1;
static int closed_socket;

static void stop_child(void) {
  if (commands >= 0) close(commands);
  if (replies >= 0) close(replies);
  commands = replies = -1;
  if (child_pid > 1) {
    int status;
    if (waitpid(child_pid, &status, 0) != child_pid || !WIFEXITED(status) || WEXITSTATUS(status)) abort();
  }
  child_pid = 0;
}

static void start_child(void) {
  int input[2], output[2];
  if (pipe(input) || pipe(output)) abort();
  child_pid = fork();
  if (child_pid < 0) abort();
  if (child_pid == 0) {
    close(input[1]); close(output[0]);
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0 || write(output[1], &fd, sizeof(fd)) != sizeof(fd)) _exit(1);
    struct pollfd in = {input[0], POLLIN, 0};
    /* Owned lifetime is bounded even if the test crashes. */
    while (poll(&in, 1, 5000) > 0) {
      char command;
      if (read(input[0], &command, 1) != 1) break;
      if (command != 'c' || close(fd)) _exit(2);
      fd = -1;
      if (write(output[1], "c", 1) != 1) _exit(3);
    }
    _exit(0);
  }
  close(input[0]); close(output[1]);
  commands = input[1]; replies = output[0];
  if (read(replies, &child_fd, sizeof(child_fd)) != sizeof(child_fd)) abort();
  closed_socket = 0;
}

static int scheduled_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int size) {
  if (type == PROC_ALL_PIDS && !(handoff_churn && handoff_done)) {
    stop_child();
    if (!census_churn) start_child();
  }
  int result = proc_listpids(type, typeinfo, buffer, size);
  int error = errno;
  /* The new live PID occurs only in the later UID/RUID lists. Repeating the
   * entire census schedules another birth, so the old helper cannot converge. */
  if (type == PROC_ALL_PIDS && census_churn) start_child();
  errno = error;
  return result;
}

static int scheduled_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
  if (handoff_churn && !handoff_done && child_matched && pid == child_pid &&
      flavor == PROC_PIDTBSDINFO) {
    /* A matching co-owner really exits after all lists and socket inspection.
     * Another owned child inherits the same client FD and remains alive. */
    handoff_done = 1;
    stop_child();
    start_child();
  }
  int departed = exit_churn && pid == child_pid && flavor == PROC_PIDLISTFDS;
  if (departed) stop_child(); /* real BSD read succeeded; the FD-list target now exits */
  int result = proc_pidinfo(pid, flavor, arg, buffer, size);
  int error = errno;
  if (departed) {
    FILE *log = fopen(observation_path, "a");
    if (log == NULL) abort();
    fprintf(log, "{\"fd_list_bytes\":%d,\"fd_list_errno\":%d}\n", result, error);
    if (fclose(log)) abort();
  }
  errno = error;
  return result;
}

static int scheduled_pidfdinfo(int pid, int fd, int flavor, void *buffer, int size) {
  if (!census_churn && !handoff_churn && pid == child_pid && fd == child_fd && !closed_socket) {
    char reply;
    if (write(commands, "c", 1) != 1 || read(replies, &reply, 1) != 1 || reply != 'c') abort();
    closed_socket = 1;
    /* LISTFDS really contained this socket. The live child now has closed it.
     * Darwin supplies the actual ESRCH/EBADF; no errno or record is fabricated. */
  }
  int result = proc_pidfdinfo(pid, fd, flavor, buffer, size);
  if (handoff_churn && !handoff_done && pid == child_pid &&
      flavor == PROC_PIDFDSOCKETINFO && result == sizeof(struct socket_fdinfo) &&
      matches((const struct socket_fdinfo *)buffer, target_client, target_server)) child_matched = 1;
  return result;
}

/* A new child inherits the real client FD after ALL_PIDS. Only the later
 * UID/RUID lists expose that second owner. Reconciliation must inspect it. */
static int shared_census(int handoff) {
  int listener = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (listener < 0 || bind(listener, (struct sockaddr *)&address, sizeof(address)) ||
      listen(listener, 1)) abort();
  socklen_t size = sizeof(address);
  if (getsockname(listener, (struct sockaddr *)&address, &size)) abort();
  int client = socket(AF_INET, SOCK_STREAM, 0);
  if (client < 0 || connect(client, (struct sockaddr *)&address, sizeof(address))) abort();
  int server = accept(listener, NULL, NULL);
  if (server < 0) abort();
  char server_port[8], client_port[8];
  snprintf(server_port, sizeof(server_port), "%u", (unsigned)ntohs(address.sin_port));
  if (getsockname(client, (struct sockaddr *)&address, &size)) abort();
  snprintf(client_port, sizeof(client_port), "%u", (unsigned)ntohs(address.sin_port));
  target_client = (uint16_t)strtoul(client_port, NULL, 10);
  target_server = (uint16_t)strtoul(server_port, NULL, 10);
  char *args[] = {"scheduled-census", client_port, server_port, "--diagnostics", NULL};
  census_churn = !handoff;
  handoff_churn = handoff;
  int result = proof_main(4, args);
  if (handoff) {
    struct socket_fdinfo socket;
    int live = child_pid > 1 && kill(child_pid, 0) == 0;
    int inherited = proc_pidfdinfo(child_pid, client, PROC_PIDFDSOCKETINFO,
                                   &socket, sizeof(socket)) == sizeof(socket) &&
                    matches(&socket, target_client, target_server);
    FILE *log = fopen(observation_path, "w");
    if (log == NULL) abort();
    fprintf(log, "{\"handoff\":%s,\"successorLive\":%s,\"successorOwnsSocket\":%s,\"proofExit\":%d}\n",
            handoff_done ? "true" : "false", live ? "true" : "false", inherited ? "true" : "false", result);
    if (fclose(log)) abort();
  }
  stop_child();
  close(client); close(server); close(listener);
  return result;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--shared-census") == 0) return shared_census(0);
  if (argc == 2 && strcmp(argv[1], "--shared-handoff") == 0) {
    if (snprintf(observation_path, sizeof(observation_path), "%s.handoff.kernel.jsonl", argv[0]) >=
        (int)sizeof(observation_path)) abort();
    return shared_census(1);
  }
  census_churn = strstr(argv[0], "census") != NULL;
  exit_churn = strstr(argv[0], "exit") != NULL;
  if (snprintf(observation_path, sizeof(observation_path), "%s.kernel.jsonl", argv[0]) >=
      (int)sizeof(observation_path)) abort();
  int result = proof_main(argc, argv);
  stop_child();
  return result;
}
