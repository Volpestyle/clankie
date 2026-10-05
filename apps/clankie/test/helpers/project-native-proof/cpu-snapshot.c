// Endpoint-only SDK CPU sampling; never used for admission or per-request proof.
#include <libproc.h>
#include <sys/resource.h>
#include <sys/proc_info.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <mach/mach_time.h>
static unsigned long long nanos(uint64_t ticks, mach_timebase_info_data_t scale) {
  return (unsigned long long)((__uint128_t)ticks * scale.numer / scale.denom);
}
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  mach_timebase_info_data_t scale = {0};
  if (mach_timebase_info(&scale) != KERN_SUCCESS || !scale.denom) return 1;
  for (int i = 1; i < argc; i++) {
    char *end = NULL;
    long value = strtol(argv[i], &end, 10);
    if (!end || *end || value <= 1 || value > 2147483647) return 2;
    pid_t pid = (pid_t)value;
    struct proc_bsdinfo info = {0};
    struct rusage_info_v4 usage = {0};
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) ||
        info.pbi_uid != getuid() || proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0) {
      fprintf(stderr, "CPU snapshot unavailable pid=%d errno=%d\n", pid, errno);
      return 1;
    }
    printf("{\"pid\":%d,\"ppid\":%u,\"birth\":[\"%llu\",\"%llu\"],\"userNs\":\"%llu\",\"systemNs\":\"%llu\",\"childUserNs\":\"%llu\",\"childSystemNs\":\"%llu\"}\n", pid, info.pbi_ppid,
      (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec,
      nanos(usage.ri_user_time, scale), nanos(usage.ri_system_time, scale),
      nanos(usage.ri_child_user_time, scale), nanos(usage.ri_child_system_time, scale));
  }
  return 0;
}
