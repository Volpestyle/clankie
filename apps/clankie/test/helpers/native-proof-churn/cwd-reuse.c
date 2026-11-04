/* A PID reused between cwd census listings (#650 review). Two real children
 * hold real working directories: A in the first directory, B in the second.
 * B is never listed. From the census's closing listing on, A's PID answers
 * with B's live kernel records (its birth and cwd), exactly what the helper
 * sees when A exits and B is born on its PID; `denied` makes that instance
 * unreadable instead. Every record comes from libproc for a real process.
 * Compile this fixture separately: the shipped helper has no test controls. */
#define __STDC_WANT_LIB_EXT1__ 1
#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static int reuse_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int size);
static int reuse_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size);
#define proc_listpids reuse_listpids
#define proc_pidinfo reuse_pidinfo
#define main proof_main
#ifndef FLEET_PROOF_SOURCE
#define FLEET_PROOF_SOURCE "../../../../../integrations/fleet-proof/native-process-proof.c"
#endif
#include FLEET_PROOF_SOURCE
#undef main
#undef proc_pidinfo
#undef proc_listpids

static pid_t reused, replacement;
static int listings, replaced, denied;

static int reuse_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int size) {
  int bytes = proc_listpids(type, typeinfo, buffer, size);
  if (bytes <= 0) return bytes;
  /* Listings 1 and 2 open the census; the third is its first closing listing. */
  if (++listings >= 3) replaced = 1;
  pid_t *pids = buffer;
  int kept = 0;
  for (int i = 0; i < bytes / (int)sizeof(pid_t); ++i)
    if (pids[i] != replacement) pids[kept++] = pids[i];
  return kept * (int)sizeof(pid_t);
}

static int reuse_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
  if (!replaced || pid != reused) return proc_pidinfo(pid, flavor, arg, buffer, size);
  if (denied) {
    errno = EPERM;
    return 0;
  }
  int bytes = proc_pidinfo(replacement, flavor, arg, buffer, size);
  if (flavor == PROC_PIDTBSDINFO && bytes == (int)sizeof(struct proc_bsdinfo))
    ((struct proc_bsdinfo *)buffer)->pbi_pid = (uint32_t)reused;
  if (flavor == PROC_PIDT_SHORTBSDINFO && bytes == (int)sizeof(struct proc_bsdshortinfo))
    ((struct proc_bsdshortinfo *)buffer)->pbsi_pid = (uint32_t)reused;
  return bytes;
}

/* A child that works in `directory` until its stdin closes, at most 10 s. */
static pid_t hold(const char *directory, int *stop) {
  int ready[2], input[2];
  if (pipe(ready) || pipe(input)) abort();
  pid_t child = fork();
  if (child < 0) abort();
  if (child == 0) {
    close(ready[0]);
    close(input[1]);
    alarm(10);
    if (chdir(directory) != 0 || write(ready[1], "r", 1) != 1) _exit(1);
    char byte;
    while (read(input[0], &byte, 1) > 0) {}
    _exit(0);
  }
  close(ready[1]);
  close(input[0]);
  char byte;
  if (read(ready[0], &byte, 1) != 1) abort();
  close(ready[0]);
  *stop = input[1];
  return child;
}

int main(int argc, char **argv) {
  if (argc != 4 || (strcmp(argv[1], "replaced") != 0 && strcmp(argv[1], "denied") != 0)) {
    fputs("usage: cwd-reuse replaced|denied FIRST_DIR REPLACEMENT_DIR\n", stderr);
    return 64;
  }
  denied = strcmp(argv[1], "denied") == 0;
  int stop_first, stop_replacement;
  reused = hold(argv[2], &stop_first);
  /* Born after A, so the two births differ. */
  usleep(2000);
  replacement = hold(argv[3], &stop_replacement);
  proof_output = stdout;
  proof_error = stderr;
  char *args[] = {argv[0], "--cwds", "--diagnostics", NULL};
  int result = execute_proof(3, args);
  fflush(stdout);
  fprintf(stderr, "closing listings: %d\n", listings - 2);
  close(stop_first);
  close(stop_replacement);
  int status;
  if (waitpid(reused, &status, 0) != reused || waitpid(replacement, &status, 0) != replacement) abort();
  return result;
}
