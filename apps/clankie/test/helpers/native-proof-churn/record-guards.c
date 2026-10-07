/* Direct defensive path checks, explicitly not records supplied by the OS.
 * Include the actual production guard/diagnostic implementations; no kernel
 * function or helper response is substituted in any live producer test. */
#define main native_proof_entry
#include "../../../../../integrations/fleet-proof/native-process-proof.c"
#undef main

static int cases, failures;
static void check(const char *label, int observed, int expected) {
  ++cases;
  if (observed != expected) ++failures;
  printf("{\"case\":\"%s\",\"refused\":%s}\n", label, observed ? "true" : "false");
}

int main(void) {
  diagnostics = 1;
  current_attempt = 1;
  proof_error = stderr;
  struct proc_fdinfo record = {0};
  check("fd-zero", invalid_fd_record(&record, 0), 0);
  record.proc_fd = INT_MAX;
  check("fd-positive", invalid_fd_record(&record, 0), 0);
  record.proc_fd = -1;
  check("fd-negative", invalid_fd_record(&record, 0), 1);
  record.proc_fd = INT_MIN;
  check("fd-minimum", invalid_fd_record(&record, 0), 1);

  struct socket_fdinfo socket = {0};
  socket.psi.soi_so = socket.psi.soi_pcb = 1;
  check("unix-generation-unused", invalid_socket_identity(&socket, 0, 0), 0);
  socket.psi.soi_so = 0;
  check("unix-socket-zero", invalid_socket_identity(&socket, 0, 0), 1);
  socket.psi.soi_so = 1;
  socket.psi.soi_pcb = 0;
  check("unix-pcb-zero", invalid_socket_identity(&socket, 0, 0), 1);
  socket.psi.soi_pcb = 1;
  check("tcp-generation-zero", invalid_socket_identity(&socket, 1, 0), 1);
  socket.psi.soi_proto.pri_tcp.tcpsi_ini.insi_gencnt = 1;
  check("tcp-complete", invalid_socket_identity(&socket, 1, 0), 0);
  socket.psi.soi_so = 0;
  check("tcp-socket-zero", invalid_socket_identity(&socket, 1, 0), 1);
  socket.psi.soi_so = 1;
  socket.psi.soi_pcb = 0;
  check("tcp-pcb-zero", invalid_socket_identity(&socket, 1, 0), 1);
  printf("{\"cases\":%d,\"failures\":%d}\n", cases, failures);
  return failures ? 1 : 0;
}
