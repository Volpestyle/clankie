# Remaining native API boundaries

This source review is not OS producer evidence. The live probes use the built,
unchanged Clankie helper; published Apple source explains candidate mechanisms
and limitations. The running host reports Darwin 27.0.0. No claim is made that
the published XNU revision is that host's exact kernel build.

## Timer wait

The helper's `clock_unavailable` reason also covers its bounded retry wait.
Apple's [nanosleep implementation](https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/gen/nanosleep.c)
uses the cancellable or noncancellable semaphore-wait syscall and propagates
non-timeout failures. A sandbox denying only those syscall IDs therefore tests
an actual per-helper OS refusal while leaving the original monotonic clock and
kernel process/socket reads intact. The SDK supplies the IDs; no clock function
or response is substituted.

## Allocation

The published [resource-limit implementation](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_resource.c)
delegates address-space and data limits to the VM map. Both
[VM limit setters](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/vm/vm_map.c)
compare a proposed cap with the already mapped size. A rejected `setrlimit` is
setup failure, not the helper's `allocation_failed` event. Accepted caps must
still let the real helper load and reach its allocation; an earlier loader
failure does not satisfy that producer criterion. Probes change only their
owned child process's soft limit within its original hard limit, without
allocating the cap's size or exhausting host memory.

## Parentage

The published [ptrace attach path](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/mach_process.c)
can reparent the traced process to its debugger. That makes an owned child
tracing its own parent a candidate for actual cyclic parent observations.
The checked owned fixture establishes that candidate on this host: actual
reciprocal PPIDs produce `ancestry_cycle` in the production helper. Only that
newly forked fixture's own parent is addressed. Its unsigned attach refused;
normal ad hoc debug signing of that fixture permits the actual attach. A stable
untraced supervisor retains the original parent through detach and confirms
actual target reaping. No debugger changes the proof helper or any existing
fleet process. See [the actual record](native.json).

## Descriptor and socket records

The published [descriptor-list implementation](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/proc_info.c)
enumerates descriptor indices under the table lock. No supported operation was
found that inserts a negative valid descriptor index into that list. API
permission or stale-descriptor failures are separate reasons; they are not
malformed successful FD records.

The published [socket-info implementation](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/socket_info.c)
builds opaque handles from actual socket/PCB objects. A null PCB leaves a
generic socket kind, which does not match the helper's TCP/Unix listener
criteria. No supported per-process operation was found that zeros a matched
socket's opaque handles while retaining the required protocol observations.
The lead revised acceptance on 2026-10-06: classify these two branches as
**defensive, not producible** through supported OS APIs on the reviewed ABI, and
accept this review plus direct tests of the production guards. This classification
does not prove that a future ABI, privacy policy or opaque-hash value can never
trigger them. Both fail-closed guards remain intact. Explicit direct guard inputs
are labeled separately from actual OS producer captures.
