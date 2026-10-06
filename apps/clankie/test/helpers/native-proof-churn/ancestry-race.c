/* Only the leaf owns TCP; root exit changes the middle ancestor's kernel PPID. */
#include <arpa/inet.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3) return 1;
  char *end = NULL;
  unsigned long port = strtoul(argv[1], &end, 10);
  if (!*argv[1] || *end || port == 0 || port > 65535) return 2;
  long delay_us = strtol(argv[2], &end, 10);
  if (!*argv[2] || *end || delay_us < 0 || delay_us > 31000) return 3;
  pid_t middle = fork();
  if (middle < 0) return 4;
  if (!middle) {
    close(STDIN_FILENO);
    pid_t leaf = fork();
    if (leaf < 0) _exit(5);
    if (!leaf) {
      int fd = socket(AF_INET, SOCK_STREAM, 0);
      struct sockaddr_in address = {0};
      address.sin_family = AF_INET;
      address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
      address.sin_port = htons((unsigned short)port);
      if (fd < 0 || connect(fd, (struct sockaddr *)&address, sizeof(address))) _exit(6);
      puts("ready"); fflush(stdout);
      struct timespec life = {0, 100000000};
      nanosleep(&life, NULL); close(fd); _exit(0);
    }
    struct timespec life = {0, 100000000};
    nanosleep(&life, NULL); _exit(0);
  }
  struct pollfd input = {STDIN_FILENO, POLLIN, 0};
  if (poll(&input, 1, 1000) < 0) return 7;
  struct timespec delay = {0, delay_us * 1000};
  nanosleep(&delay, NULL);
  return 0;
}
