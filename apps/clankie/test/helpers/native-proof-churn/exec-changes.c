/* Real owned exec transitions; the proof's kernel reads are unchanged. */
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
int main(int argc, char **argv) {
  if (argc != 6) return 1;
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now)) return 2;
  int64_t at = (int64_t)now.tv_sec * INT64_C(1000000000) + now.tv_nsec;
  int64_t until = strcmp(argv[4], "start") == 0 ? at + INT64_C(3000000000) : strtoll(argv[3], NULL, 10);
  if (at >= until) return 0;
  struct pollfd input = {STDIN_FILENO, POLLIN, 0};
  if (poll(&input, 1, 0) != 0) return 0;
  int phase = strcmp(argv[4], "1") != 0;
  if (strcmp(argv[4], "start") == 0) { puts("ready"); fflush(stdout); }
  if (strcmp(argv[5], "argv") == 0) {
    size_t bytes = strlen(argv[0]);
    struct timespec pause = {0, 100000};
    do {
      /* A running program can change its own argument storage. The kernel's
       * actual KERN_PROCARGS2 observations decide whether this is visible. */
      memset(argv[0], phase ? 'a' : 'b', bytes); phase = !phase;
      nanosleep(&pause, NULL);
      if (poll(&input, 1, 0) != 0) return 0;
      if (clock_gettime(CLOCK_MONOTONIC, &now)) return 5;
    } while ((int64_t)now.tv_sec * INT64_C(1000000000) + now.tv_nsec < until);
    return 0;
  }
  char label[513];
  size_t length = phase ? 512 : 16;
  memset(label, phase ? 'a' : 'b', length); label[length] = 0;
  struct timespec delay = {0, 400000};
  nanosleep(&delay, NULL);
  char deadline[32];
  if (snprintf(deadline, sizeof(deadline), "%lld", (long long)until) <= 0) return 4;
  char *next[] = {label, argv[1], argv[2], deadline, phase ? "1" : "0", argv[5], NULL};
  execve(strcmp(argv[5], "argv") == 0 || phase ? argv[1] : argv[2], next, environ);
  return 3;
}
