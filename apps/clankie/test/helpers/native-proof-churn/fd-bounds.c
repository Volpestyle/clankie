/* Owned OS boundary: a real TCP client with an oversized kernel FD table. */
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 1;
  char *end = NULL;
  errno = 0;
  unsigned long port = strtoul(argv[1], &end, 10);
  if (errno || !*argv[1] || *end || !port || port > 65535) return 2;
  struct rlimit limit;
  if (getrlimit(RLIMIT_NOFILE, &limit)) return 3;
  /* Change only this owned process's soft limit, never the host or hard cap. */
  if (limit.rlim_max < 16416) return 4;
  limit.rlim_cur = 16416;
  if (setrlimit(RLIMIT_NOFILE, &limit)) return 5;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons((uint16_t)port);
  if (fd < 0 || connect(fd, (struct sockaddr *)&address, sizeof(address))) return 6;
  int source = open("/dev/null", O_RDONLY);
  if (source < 0) return 7;
  /* MAX_FDS is 16384 in the unchanged production helper. */
  for (int count = 0; count < 16384; ++count) if (dup(source) < 0) return 8;
  puts("ready"); fflush(stdout);
  struct pollfd input = {STDIN_FILENO, POLLIN, 0};
  /* Bounded lifetime even if the driver fails before closing its input. */
  return poll(&input, 1, 1500) < 0 ? 9 : 0;
}
