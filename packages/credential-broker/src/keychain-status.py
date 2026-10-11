"""Bounded, noninteractive macOS Keychain lock observation. Never unlock a keychain."""

import ctypes as c
import json
import sys

security = c.CDLL("/System/Library/Frameworks/Security.framework/Security")
security.SecKeychainSetUserInteractionAllowed.argtypes = [c.c_bool]
security.SecKeychainOpen.argtypes = [c.c_char_p, c.POINTER(c.c_void_p)]
security.SecKeychainCopyDefault.argtypes = [c.POINTER(c.c_void_p)]
security.SecKeychainGetStatus.argtypes = [c.c_void_p, c.POINTER(c.c_uint32)]
security.SecKeychainGetPath.argtypes = [c.c_void_p, c.POINTER(c.c_uint32), c.c_void_p]


def check(code):
    if code:
        # Fixed metadata only; never print a native exception or credential.
        print(json.dumps({"code": code}))
        sys.exit(1)


request = json.load(sys.stdin)
check(security.SecKeychainSetUserInteractionAllowed(False))
keychain = c.c_void_p()
path = request.get("keychain")
check(
    security.SecKeychainOpen(path.encode(), c.byref(keychain))
    if path
    else security.SecKeychainCopyDefault(c.byref(keychain))
)
status = c.c_uint32()
check(security.SecKeychainGetStatus(keychain, c.byref(status)))
if not status.value & 1:  # kSecUnlockStateStatus
    check(-25308)  # errSecInteractionNotAllowed
length = c.c_uint32(4096)
buffer = c.create_string_buffer(length.value)
check(security.SecKeychainGetPath(keychain, c.byref(length), buffer))
print(json.dumps({"ready": True, "path": buffer.value.decode()}))
