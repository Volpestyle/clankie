"""Clankie's protected keychain (VUH-2592): create, ensure and unlock without prompts or argv secrets.

The keychain file holds the operator credential outside the login keychain, so a
worker sandbox can deny the file. Its random unlock password is a generic
password in the password keychain (the default keychain unless a path is given).
Reads JSON from stdin; prints fixed metadata only, never a password.
"""

import ctypes as c
import json
import os
import secrets
import sys

security = c.CDLL("/System/Library/Frameworks/Security.framework/Security")
core = c.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")


class Settings(c.Structure):
    _fields_ = [
        ("version", c.c_uint32),
        ("lockOnSleep", c.c_bool),
        ("useLockInterval", c.c_bool),
        ("lockInterval", c.c_uint32),
    ]


security.SecKeychainSetUserInteractionAllowed.argtypes = [c.c_bool]
security.SecKeychainOpen.argtypes = [c.c_char_p, c.POINTER(c.c_void_p)]
security.SecKeychainCreate.argtypes = [
    c.c_char_p,
    c.c_uint32,
    c.c_void_p,
    c.c_bool,
    c.c_void_p,
    c.POINTER(c.c_void_p),
]
security.SecKeychainSetSettings.argtypes = [c.c_void_p, c.POINTER(Settings)]
security.SecKeychainUnlock.argtypes = [c.c_void_p, c.c_uint32, c.c_void_p, c.c_bool]
security.SecKeychainAddGenericPassword.argtypes = [
    c.c_void_p,
    c.c_uint32,
    c.c_char_p,
    c.c_uint32,
    c.c_char_p,
    c.c_uint32,
    c.c_void_p,
    c.POINTER(c.c_void_p),
]
security.SecKeychainFindGenericPassword.argtypes = [
    c.c_void_p,
    c.c_uint32,
    c.c_char_p,
    c.c_uint32,
    c.c_char_p,
    c.POINTER(c.c_uint32),
    c.POINTER(c.c_void_p),
    c.POINTER(c.c_void_p),
]
security.SecKeychainItemFreeContent.argtypes = [c.c_void_p, c.c_void_p]
core.CFRelease.argtypes = [c.c_void_p]


def fail(code):
    # Fixed metadata only; never print a native exception or credential.
    print(json.dumps({"code": code}))
    sys.exit(1)


def check(code):
    if code:
        fail(code)


def open_keychain(path):
    keychain = c.c_void_p()
    check(security.SecKeychainOpen(path.encode(), c.byref(keychain)))
    return keychain


def create(path, password):
    keychain = c.c_void_p()
    check(security.SecKeychainCreate(path.encode(), len(password), password, False, None, c.byref(keychain)))
    # A service keychain stays unlocked for the login session; it never locks on sleep or idle.
    settings = Settings(version=1, lockOnSleep=False, useLockInterval=False, lockInterval=0x7FFFFFFF)
    check(security.SecKeychainSetSettings(keychain, c.byref(settings)))
    core.CFRelease(keychain)


def find_password(request):
    store = open_keychain(request["passwordKeychain"]) if request.get("passwordKeychain") else None
    service = request["service"].encode()
    account = request["account"].encode()
    length = c.c_uint32()
    data = c.c_void_p()
    code = security.SecKeychainFindGenericPassword(
        store, len(service), service, len(account), account, c.byref(length), c.byref(data), None
    )
    if code == -25300:  # errSecItemNotFound
        return None
    check(code)
    password = c.string_at(data, length.value)
    security.SecKeychainItemFreeContent(None, data)
    return password


request = json.load(sys.stdin)
check(security.SecKeychainSetUserInteractionAllowed(False))
op = request.get("op")
path = request.get("keychain")
if not isinstance(path, str) or not os.path.isabs(path):
    fail(-50)  # errSecParam

if op == "create":
    # Tests create their own password keychain with a password they choose.
    create(path, request["password"].encode())
    print(json.dumps({"ready": True}))
elif op == "ensure":
    if os.path.exists(path):
        print(json.dumps({"ready": True, "created": False}))
        sys.exit(0)
    if find_password(request) is not None:
        # A password without its keychain means a lost file; never overwrite the old password.
        fail(-25299)  # errSecDuplicateItem
    password = secrets.token_hex(32).encode()
    store = open_keychain(request["passwordKeychain"]) if request.get("passwordKeychain") else None
    service = request["service"].encode()
    account = request["account"].encode()
    check(
        security.SecKeychainAddGenericPassword(
            store, len(service), service, len(account), account, len(password), password, None
        )
    )
    create(path, password)
    print(json.dumps({"ready": True, "created": True}))
elif op == "unlock":
    password = find_password(request)
    if password is None:
        fail(-25300)
    keychain = open_keychain(path)
    check(security.SecKeychainUnlock(keychain, len(password), password, True))
    core.CFRelease(keychain)
    print(json.dumps({"ready": True}))
else:
    fail(-50)
