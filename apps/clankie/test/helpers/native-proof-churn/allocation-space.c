/* Manual isolated x86_64 producer: original allocator and kernel APIs.
 * No allocator replacement or manufactured helper response. Child exit drops
 * all mappings; alarm and reservation/buffer bounds limit the owned workload. */
#define main native_proof_entry
#include "../../../../../integrations/fleet-proof/native-process-proof.c"
#undef main
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <malloc/malloc.h>
#include <dlfcn.h>

int main(int argc, char **argv) {
  if (argc != 3 && argc != 4) return 3;
  alarm(5);
  setvbuf(stdout, NULL, _IONBF, 0);
  setvbuf(stderr, NULL, _IONBF, 0);
  if (argc == 4) {
    char *arguments[] = {argv[0], argv[1], argv[2], "--diagnostics", NULL};
    return native_proof_entry(4, arguments);
  }
  fprintf(stderr, "Owned sparse address-space probe loaded\n");
  void (*legacy)(void) = dlsym(RTLD_DEFAULT, "malloc_create_legacy_default_zone");
  if (!legacy) return 7;
  legacy();
  malloc_zone_t *fresh = malloc_default_zone();
  vm_address_t *zones;
  unsigned zone_count;
  if (!fresh || malloc_get_all_zones(mach_task_self(), NULL, &zones, &zone_count) || zone_count > 32) return 6;
  malloc_zone_t *originals[32];
  for (unsigned i = 0; i < zone_count; i++) originals[i] = (malloc_zone_t *)zones[i];
  for (unsigned i = 0; i < zone_count; i++) {
    if (originals[i] != fresh) {
      malloc_zone_unregister(originals[i]);
      malloc_zone_register(originals[i]);
    }
  }
  fprintf(stderr, "Owned stock default zone: %s\n", fresh->zone_name);
  unsigned reservations = 0;
  const int tags[] = {0, VM_MEMORY_MALLOC, VM_MEMORY_MALLOC_SMALL, VM_MEMORY_MALLOC_LARGE};
  for (unsigned tag = 0; tag < sizeof(tags) / sizeof(tags[0]); tag++) {
    for (mach_vm_size_t size = UINT64_C(1) << 46; size >= 16384; size >>= 1) {
      while (reservations < 1024) {
        mach_vm_address_t address = 0;
        kern_return_t result = mach_vm_map(
          mach_task_self(), &address, size, 0,
          VM_FLAGS_ANYWHERE | VM_MAKE_TAG(tags[tag]), MEMORY_OBJECT_NULL, 0,
          FALSE, VM_PROT_NONE, VM_PROT_NONE, VM_INHERIT_DEFAULT);
        if (result != KERN_SUCCESS) break;
        reservations++;
      }
    }
  }
  fprintf(stderr, "Owned sparse reservations: %u\n", reservations);
  if (reservations == 1024) return 5;
  /* Consume at most 32 MiB of preexisting stock allocator space.
   * Reservations are untouched PROT_NONE mappings, not committed host RAM. */
  void *held[256];
  unsigned retained = 0;
  for (; retained < 256; retained++) {
    held[retained] = calloc(MAX_FDS, sizeof(struct proc_fdinfo));
    if (!held[retained]) break;
    if (retained == 0) fprintf(stderr, "Actual buffer zone: %s\n", malloc_zone_from_ptr(held[retained])->zone_name);
  }
  fprintf(stderr, "Owned retained buffers: %u\n", retained);
  char *arguments[] = {argv[0], argv[1], argv[2], "--diagnostics", NULL};
  return native_proof_entry(4, arguments);
}
