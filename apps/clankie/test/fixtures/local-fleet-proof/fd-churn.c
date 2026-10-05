/* Real, owned socket-to-vnode descriptor replacement. Stops on stdin or in 5s. */
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

enum { COUNT = 2048, SECONDS = 5, THREADS = 4 };
static int fds[COUNT];
static struct timespec began;

static void *churn(void *arg) {
  int offset = (int)(intptr_t)arg;
  struct timespec now;
  struct pollfd input = {STDIN_FILENO, POLLIN, 0};
  do {
    for (int i = offset; i < COUNT; i += THREADS) {
      close(fds[i]);
      fds[i] = open("/dev/null", O_RDONLY);
      if (fds[i] < 0) _exit(1);
    }
    for (int i = offset; i < COUNT; i += THREADS) {
      close(fds[i]);
      fds[i] = socket(AF_INET, SOCK_STREAM, 0);
      if (fds[i] < 0) _exit(1);
    }
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) _exit(1);
  } while (now.tv_sec - began.tv_sec < SECONDS && poll(&input, 1, 0) == 0);
  return NULL;
}

int main(void) {
  struct rlimit limit;
  if (getrlimit(RLIMIT_NOFILE, &limit) != 0) return 1;
  if (limit.rlim_cur < COUNT + 16) {
    limit.rlim_cur = COUNT + 16;
    if (setrlimit(RLIMIT_NOFILE, &limit) != 0) return 1;
  }
  for (int i = 0; i < COUNT; ++i) {
    fds[i] = socket(AF_INET, SOCK_STREAM, 0);
    if (fds[i] < 0) return 1;
  }
  if (clock_gettime(CLOCK_MONOTONIC, &began) != 0) return 1;
  pthread_t threads[THREADS];
  for (int i = 0; i < THREADS; ++i)
    if (pthread_create(&threads[i], NULL, churn, (void *)(intptr_t)i) != 0) return 1;
  puts("ready");
  fflush(stdout);
  for (int i = 0; i < THREADS; ++i) pthread_join(threads[i], NULL);
  for (int i = 0; i < COUNT; ++i) close(fds[i]);
  return 0;
}
