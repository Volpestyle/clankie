/* A real parent exit changes the live leaf's kernel PPID. No proof inputs change. */
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 1;
  char *end = NULL;
  long delay_us = strtol(argv[1], &end, 10);
  if (!*argv[1] || *end || delay_us < 0 || delay_us > 3100) return 2;
  pid_t leaf = fork();
  if (leaf < 0) return 3;
  if (!leaf) {
    close(STDIN_FILENO);
    struct timespec lifetime = {0, 20000000};
    nanosleep(&lifetime, NULL);
    _exit(0);
  }
  printf("%d\n", leaf); fflush(stdout);
  struct pollfd input = {STDIN_FILENO, POLLIN, 0};
  if (poll(&input, 1, 1000) < 0) return 4;
  struct timespec delay = {0, delay_us * 1000};
  nanosleep(&delay, NULL);
  return 0;
}
