/* Actual SDK syscall IDs and libc timer behavior, not a replacement clock. */
#include <errno.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <time.h>

int main(void) {
  struct timespec now, wait = {0, 1000000}, rest;
  int clock_result = clock_gettime(CLOCK_MONOTONIC, &now);
  errno = 0;
  int wait_result = nanosleep(&wait, &rest);
  int error = wait_result < 0 ? errno : 0;
  printf("{\"clockResult\":%d,\"waitResult\":%d,\"waitErrno\":%d,"
         "\"waitSyscalls\":[%d,%d]}\n", clock_result, wait_result, error,
         SYS___semwait_signal, SYS___semwait_signal_nocancel);
  return 0;
}
