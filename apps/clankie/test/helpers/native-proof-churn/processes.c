/* Owned real-kernel fixtures only: no production proof inputs are replaced. */
#include <arpa/inet.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int churn(long seconds) {
  struct timespec began, now;
  if (clock_gettime(CLOCK_MONOTONIC, &began)) return 1;
  unsigned count = 0;
  puts("ready"); fflush(stdout);
  struct pollfd input = {STDIN_FILENO, POLLIN, 0};
  do {
    pid_t child = fork();
    if (child < 0) return 2;
    if (!child) { struct timespec wait = {0, 500000}; nanosleep(&wait, NULL); _exit(0); }
    int status;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status)) return 3;
    ++count;
    if (clock_gettime(CLOCK_MONOTONIC, &now)) return 4;
  } while (now.tv_sec - began.tv_sec < seconds && poll(&input, 1, 0) == 0);
  printf("completed %u owned births\n", count);
  return 0;
}

static int share(void) {
  int type;
  socklen_t bytes = sizeof(type);
  if (getsockopt(3, SOL_SOCKET, SO_TYPE, &type, &bytes) || type != SOCK_STREAM) return 1;
  puts("ready"); fflush(stdout);
  struct pollfd input = {STDIN_FILENO, POLLIN, 0};
  if (poll(&input, 1, 10000) < 0) return 2;
  close(3);
  return 0;
}

static int descendant(unsigned port) {
  pid_t child = fork();
  if (child < 0) return 1;
  if (!child) {
    close(STDIN_FILENO);
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons((uint16_t)port);
    if (fd < 0 || connect(fd, (struct sockaddr *)&address, sizeof(address))) _exit(2);
    socklen_t bytes = sizeof(address);
    if (getsockname(fd, (struct sockaddr *)&address, &bytes)) _exit(3);
    printf("ready %d %u\n", getpid(), (unsigned)ntohs(address.sin_port)); fflush(stdout);
    /* Fixed lifetime even if the test fails before cleanup. Parent holds no
     * client FD; its exit genuinely reparents this independently live owner. */
    sleep(10);
    close(fd);
    _exit(0);
  }
  struct pollfd input = {STDIN_FILENO, POLLIN, 0};
  if (poll(&input, 1, 10000) < 0) { kill(child, SIGTERM); waitpid(child, NULL, 0); return 4; }
  return 0;
}

/* A real bounded ancestry deeper than the production MAX_CHAIN=64. Only
 * the leaf opens the client socket; parents keep their actual lifetimes. */
static int deep_ancestry(unsigned depth, unsigned port) {
  if (depth) {
    pid_t child = fork();
    if (child < 0) return 1;
    if (!child) _exit(deep_ancestry(depth - 1, port));
    int status;
    return waitpid(child, &status, 0) == child && WIFEXITED(status) ? WEXITSTATUS(status) : 2;
  }
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons((uint16_t)port);
  if (fd < 0 || connect(fd, (struct sockaddr *)&address, sizeof(address))) return 3;
  printf("ready %d\n", getpid()); fflush(stdout);
  sleep(5);
  close(fd);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "churn") == 0) return churn(5);
  /* A longer owned window for a rare per-PID retry; stdin closure still ends it. */
  if (argc == 3 && strcmp(argv[1], "churn") == 0 && strcmp(argv[2], "30") == 0) return churn(30);
  if (argc == 2 && strcmp(argv[1], "share") == 0) return share();
  if (argc == 3 && (strcmp(argv[1], "descendant") == 0 || strcmp(argv[1], "ancestry") == 0)) {
    char *end = NULL;
    errno = 0;
    unsigned long port = strtoul(argv[2], &end, 10);
    if (errno || !*argv[2] || *end || port == 0 || port > 65535) return 5;
    return strcmp(argv[1], "ancestry") == 0 ? deep_ancestry(65, (unsigned)port) : descendant((unsigned)port);
  }
  return 6;
}
