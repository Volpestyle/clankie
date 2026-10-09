/* A real, isolated Darwin process tree for kernel usage accounting; boots no device. */
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
#include <time.h>
static volatile sig_atomic_t stopped = 0;
static void stop(int signal) { (void)signal; stopped = 1; }
int main(void) {
    signal(SIGTERM, stop);
    pid_t child = fork();
    if (child == 0) { execl("/bin/sleep", "sleep", "60", NULL); _exit(1); }
    if (child < 0) return 1;
    while (!stopped) {
        struct timespec start, now;
        clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &start);
        do {
            clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &now);
        } while (!stopped && (now.tv_sec - start.tv_sec) * 1000000000L + now.tv_nsec - start.tv_nsec < 30000000L);
        sleep(1);
    }
    kill(child, SIGTERM);
    waitpid(child, NULL, 0);
    return 0;
}
