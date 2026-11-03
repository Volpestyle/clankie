/* A real CPU consumer for #332's pressure-naming test. Named "claude" it starts
 * its argv as a child, like a worker starting a test run; under any other name
 * it spins three threads for argv[1] seconds and exits on its own. */
#include <libgen.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static time_t end;
static void *spin(void *unused) {
  volatile unsigned long n = 0;
  while (time(NULL) < end) n++;
  return unused;
}

int main(int argc, char **argv) {
  if (strcmp(basename(argv[0]), "claude") == 0) {
    if (argc < 2) return 2;
    pid_t child = fork();
    if (child < 0) return 3;
    if (child == 0) {
      execv(argv[1], argv + 1);
      _exit(127);
    }
    int status;
    waitpid(child, &status, 0);
    return 0;
  }
  end = time(NULL) + (argc > 1 ? atoi(argv[1]) : 10);
  pthread_t threads[2];
  for (int i = 0; i < 2; i++) pthread_create(&threads[i], NULL, spin, NULL);
  spin(NULL);
  for (int i = 0; i < 2; i++) pthread_join(threads[i], NULL);
  return 0;
}
