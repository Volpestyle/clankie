/* Preserve actual empty argv positions across a real exec, never fake records. */
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc < 4) return 2;
  const char *executable = argv[1];
  if (strcmp(argv[2], "argv0") == 0) {
    argv[2] = "";
    execv(executable, &argv[2]);
  } else if (strcmp(argv[2], "argv1") == 0) {
    argv[2] = (char *)executable;
    argv[3] = "";
    execv(executable, &argv[2]);
  }
  perror("execv");
  return 1;
}
