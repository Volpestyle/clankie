#include <arpa/inet.h>
#include <errno.h>
#include <libproc.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static int target(int argc, char **argv, int completion) {
 if(argc!=2)return 1;
 int ready[2];if(pipe(ready))return 2;
 pid_t root=getpid(), child=fork();if(child<0)return 3;
 if(!child) {
  alarm(3); /* Bound the tracer; the supervisor still requires actual target exit. */
  close(ready[1]);close(STDIN_FILENO);
  char byte;if(read(ready[0],&byte,1)!=1)_exit(4);close(ready[0]);
  errno=0;int attached=ptrace(PT_ATTACH,root,NULL,0);
  if(attached){printf("attach refused %d\n",errno);fflush(stdout);_exit(11);}
  int status;if(waitpid(root,&status,WUNTRACED)!=root)_exit(5);
  struct proc_bsdinfo a,b;
  int first=proc_pidinfo(root,PROC_PIDTBSDINFO,0,&a,sizeof(a));
  int second=proc_pidinfo(getpid(),PROC_PIDTBSDINFO,0,&b,sizeof(b));
  printf("attached %d %d\n",first==(int)sizeof(a)&&a.pbi_ppid==(unsigned)getpid(),second==(int)sizeof(b)&&b.pbi_ppid==(unsigned)root);fflush(stdout);
  struct timespec life={1,0};nanosleep(&life,NULL);
  if(ptrace(PT_DETACH,root,(caddr_t)1,0))_exit(6);
  if(kill(root,SIGCONT))_exit(12);
  if(write(completion,"x",1)!=1)_exit(13);
  close(completion);_exit(0);
 }
 close(ready[0]);close(completion);
 int fd=socket(AF_INET,SOCK_STREAM,0);struct sockaddr_in address={0};
 address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);address.sin_port=htons((unsigned short)strtoul(argv[1],NULL,10));
 if(fd<0||connect(fd,(struct sockaddr*)&address,sizeof(address)))return 7;
 if(write(ready[1],"x",1)!=1)return 8;close(ready[1]);
 struct pollfd input={STDIN_FILENO,POLLIN,0};poll(&input,1,1500);
 close(fd);int status;if(waitpid(child,&status,0)!=child)return 9;
 return WIFEXITED(status)&&WEXITSTATUS(status)==0?0:10;
}

/* Keep an untraced original parent alive. A high-level wait can report ECHILD
 * during debugger reparenting; that is not a kernel exit receipt. */
int main(int argc, char **argv) {
 int completion[2], start[2];if(pipe(completion)||pipe(start))return 14;
 pid_t owned=fork();if(owned<0)return 15;
 if(!owned){
  close(completion[0]);close(start[1]);char byte;
  if(read(start[0],&byte,1)!=1)return 18;
  close(start[0]);return target(argc,argv,completion[1]);
 }
 close(completion[1]);close(start[0]);close(STDIN_FILENO);
 struct proc_bsdinfo original;
 if(proc_pidinfo(owned,PROC_PIDTBSDINFO,0,&original,sizeof(original))!=(int)sizeof(original))return 19;
 if(write(start[1],"x",1)!=1)return 20;close(start[1]);
 char byte;ssize_t receipt;
 do{receipt=read(completion[0],&byte,1);}while(receipt<0&&errno==EINTR);
 close(completion[0]);
 if(receipt!=1){
  /* On attach refusal or tracer death, continue only this original lifetime
   * after its original parentage is restored. Never signal a replacement. */
  for(int i=0;i<300;i++){
   struct proc_bsdinfo now;
   if(proc_pidinfo(owned,PROC_PIDTBSDINFO,0,&now,sizeof(now))!=(int)sizeof(now))break;
   if(now.pbi_start_tvsec!=original.pbi_start_tvsec||now.pbi_start_tvusec!=original.pbi_start_tvusec)break;
   if(now.pbi_ppid==(unsigned)getpid()){kill(owned,SIGCONT);break;}
   struct timespec pause={0,10000000};nanosleep(&pause,NULL);
  }
 }
 /* A detach receipt precedes this wait; ECHILD is never an exit receipt.
  * Bounded: if the tracer died before detaching, keep continuing only this
  * original lifetime once it is ours again, then kill it rather than hang. */
 int status;pid_t result=0;
 for(int i=0;i<1000&&result!=owned;i++){
  result=waitpid(owned,&status,WNOHANG);
  if(result==owned)break;
  if(result<0&&errno!=EINTR&&errno!=ECHILD)return 16;
  struct proc_bsdinfo now;
  if(receipt!=1&&proc_pidinfo(owned,PROC_PIDTBSDINFO,0,&now,sizeof(now))==(int)sizeof(now)&&
     now.pbi_start_tvsec==original.pbi_start_tvsec&&now.pbi_start_tvusec==original.pbi_start_tvusec&&
     now.pbi_ppid==(unsigned)getpid())kill(owned,SIGCONT);
  struct timespec pause={0,10000000};nanosleep(&pause,NULL);
 }
 if(result!=owned){
  kill(owned,SIGKILL);
  do{result=waitpid(owned,&status,0);}while(result<0&&errno==EINTR);
  printf("unreaped killed\n");fflush(stdout);
  return 21;
 }
 int code=WIFEXITED(status)?WEXITSTATUS(status):17;
 printf("reaped %d\n",code);fflush(stdout);
 return code;
}
