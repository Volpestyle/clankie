import ctypes as c
import os, json, collections, time

cf = c.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
fs = c.CDLL('/System/Library/Frameworks/CoreServices.framework/Frameworks/FSEvents.framework/FSEvents')
cf.CFStringCreateWithCString.argtypes = [c.c_void_p, c.c_char_p, c.c_uint32]
cf.CFStringCreateWithCString.restype = c.c_void_p
cf.CFArrayCreate.argtypes = [c.c_void_p, c.POINTER(c.c_void_p), c.c_long, c.c_void_p]
cf.CFArrayCreate.restype = c.c_void_p
cf.CFRunLoopGetCurrent.restype = c.c_void_p
cf.CFRunLoopRunInMode.argtypes = [c.c_void_p, c.c_double, c.c_bool]
cf.CFRelease.argtypes = [c.c_void_p]
callback_type = c.CFUNCTYPE(None, c.c_void_p, c.c_void_p, c.c_size_t, c.c_void_p, c.POINTER(c.c_uint32), c.POINTER(c.c_uint64))
counts = collections.Counter()
flags_count = collections.Counter()
home = os.path.expanduser('~')
def category(path):
    if path.startswith('/private/var/folders/'):
        pieces = path.split('/')
        for bucket in ['T', 'C']:
            if bucket in pieces:
                i = pieces.index(bucket)
                child = pieces[i+1] if len(pieces) > i+1 else '(root)'
                if child.startswith('metro'):
                    child = 'metro-cache'
                elif child.startswith('clankie'):
                    child = 'clankie-test-temporary'
                elif child.startswith('vitest'):
                    child = 'vitest-temporary'
                return 'temporary/' + bucket + '/' + child
        return 'temporary/other'
    rel = path.removeprefix(home + '/')
    parts = rel.split('/')
    if 'node_modules' in parts:
        return '/'.join(parts[:parts.index('node_modules') + 1])
    if 'DerivedData' in parts:
        return '/'.join(parts[:parts.index('DerivedData') + 1])
    if 'CoreSimulator' in parts:
        return 'Library/Developer/CoreSimulator'
    if any('metro' in part.lower() for part in parts):
        return '/'.join(parts[:4])
    if parts[:2] in [['dev', 'clankie-wt'], ['dev', 'clankie-app-wt']]:
        return '/'.join(parts[:4])
    return '/'.join(parts[:2])
@callback_type
def receive(stream, context, count, paths, flags, ids):
    array = c.cast(paths, c.POINTER(c.c_char_p))
    for i in range(count):
        counts[category(os.fsdecode(array[i]))] += 1
        for mask, label in [(1, 'MustScanSubDirs'), (2, 'UserDropped'), (4, 'KernelDropped')]:
            if flags[i] & mask:
                flags_count[label] += 1
roots = [home + '/dev', home + '/Library/Developer', home + '/.clankie', home + '/Library/Caches', '/private/var/folders']
strings = [cf.CFStringCreateWithCString(None, p.encode(), 0x08000100) for p in roots]
array = cf.CFArrayCreate(None, (c.c_void_p * len(strings))(*strings), len(strings), None)
fs.FSEventStreamCreate.argtypes = [c.c_void_p, callback_type, c.c_void_p, c.c_void_p, c.c_uint64, c.c_double, c.c_uint32]
fs.FSEventStreamCreate.restype = c.c_void_p
stream = fs.FSEventStreamCreate(None, receive, None, array, 0xffffffffffffffff, 0.25, 0x10 | 0x2)
fs.FSEventStreamScheduleWithRunLoop.argtypes = [c.c_void_p, c.c_void_p, c.c_void_p]
mode = c.c_void_p.in_dll(cf, 'kCFRunLoopDefaultMode')
fs.FSEventStreamScheduleWithRunLoop(stream, cf.CFRunLoopGetCurrent(), mode)
fs.FSEventStreamStart.argtypes = [c.c_void_p]
fs.FSEventStreamStart.restype = c.c_bool
if not fs.FSEventStreamStart(stream):
    raise RuntimeError('FSEvents stream refused')
started = time.time()
cf.CFRunLoopRunInMode(mode, 20, False)
for name in ['FSEventStreamStop', 'FSEventStreamInvalidate', 'FSEventStreamRelease']:
    fn = getattr(fs, name)
    fn.argtypes = [c.c_void_p]
    fn(stream)
cf.CFRelease(array)
for value in strings:
    cf.CFRelease(value)
print(json.dumps({'startedAt': started, 'seconds': time.time()-started, 'events': sum(counts.values()), 'flags': dict(flags_count), 'paths': counts.most_common()}, indent=2))
