#include <errno.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void fail(const char *message) {
  fprintf(stderr, "clankie: %s: %s\n", message, strerror(errno));
  exit(1);
}

int main(int argc, char **argv) {
  char executable[PATH_MAX];
  uint32_t executable_size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &executable_size) != 0) {
    errno = ENAMETOOLONG;
    fail("cannot locate the launcher");
  }

  char resolved[PATH_MAX];
  if (realpath(executable, resolved) == NULL) fail("cannot resolve the launcher");

  char root[PATH_MAX];
  if (snprintf(root, sizeof(root), "%s", resolved) >= (int)sizeof(root)) {
    errno = ENAMETOOLONG;
    fail("launcher path is too long");
  }
  char *last_slash = strrchr(root, '/');
  if (last_slash == NULL) {
    errno = EINVAL;
    fail("launcher is outside its release directory");
  }
  *last_slash = '\0';
  last_slash = strrchr(root, '/');
  if (last_slash == NULL) {
    errno = EINVAL;
    fail("launcher is outside its release directory");
  }
  *last_slash = '\0';

  char node[PATH_MAX];
  char entrypoint[PATH_MAX];
  if (snprintf(node, sizeof(node), "%s/libexec/node", root) >= (int)sizeof(node) ||
      snprintf(entrypoint, sizeof(entrypoint), "%s/apps/tui/bin/clankie.js", root) >=
          (int)sizeof(entrypoint)) {
    errno = ENAMETOOLONG;
    fail("runtime path is too long");
  }

  if (access(node, X_OK) != 0) fail("bundled Node runtime is missing");
  if (access(entrypoint, R_OK) != 0) fail("Clankie runtime is missing");
  if (setenv("CLANKIE_INSTALL_ROOT", root, 1) != 0 ||
      setenv("CLANKIE_LAUNCHER_PATH", resolved, 1) != 0) {
    fail("cannot prepare the runtime environment");
  }

  char **node_argv = calloc((size_t)argc + 2, sizeof(char *));
  if (node_argv == NULL) fail("cannot allocate launcher arguments");
  node_argv[0] = node;
  node_argv[1] = entrypoint;
  for (int index = 1; index < argc; index++) node_argv[index + 1] = argv[index];

  execv(node, node_argv);
  fail("cannot start the bundled Node runtime");
}
