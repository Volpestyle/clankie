"""Read-only Linux UNIX socket peer evidence; no agent/provider operations.

ABI: Linux v6.12 include/uapi/linux/{unix_diag,sock_diag}.h and net/unix/diag.c.
The syscall ABI is GPL-2.0 WITH Linux-syscall-note; this implementation is original.
"""
import json
import socket
import struct
import sys


def parse_messages(data):
    records = []
    done = False
    offset = 0
    while offset < len(data):
        if len(data) - offset < 16:
            raise ValueError("Truncated netlink header")
        length, kind, flags, sequence, _ = struct.unpack_from("=IHHII", data, offset)
        if length < 16 or offset + length > len(data) or sequence != 1:
            raise ValueError("Invalid netlink framing/sequence")
        body = data[offset + 16:offset + length]
        if flags & 0x10:  # NLM_F_DUMP_INTR: never treat partial inventory as complete.
            raise ValueError("Interrupted socket inventory")
        if done:
            raise ValueError("Data after completed inventory")
        if kind == 3:
            if len(body) != 4 or struct.unpack("=i", body)[0] != 0:
                raise ValueError("Incomplete kernel socket inventory")
            done = True
        elif kind == 2:
            raise ValueError("Kernel socket diagnostics failed")
        elif kind == 20:
            if len(body) < 16:
                raise ValueError("Truncated UNIX diagnostic")
            family, sock_type, state, _, inode, _, _ = struct.unpack_from("=BBBBIII", body)
            if family != socket.AF_UNIX:
                raise ValueError("Unexpected socket family")
            record = {"inode": inode, "state": state, "type": sock_type}
            attr = 16
            while attr < len(body):
                if len(body) - attr < 4:
                    raise ValueError("Truncated socket attribute")
                size, tag = struct.unpack_from("=HH", body, attr)
                if size < 4 or attr + size > len(body):
                    raise ValueError("Invalid socket attribute")
                value = body[attr + 4:attr + size]
                if tag == 0:  # UNIX_DIAG_NAME
                    record["path"] = value.rstrip(b"\0").decode("utf-8", "strict")
                elif tag == 2:  # UNIX_DIAG_PEER
                    if len(value) != 4:
                        raise ValueError("Invalid peer inode")
                    record["peer"] = struct.unpack("=I", value)[0]
                attr += (size + 3) & ~3
            records.append(record)
        else:
            raise ValueError("Unexpected kernel diagnostic message")
        offset += (length + 3) & ~3
    return records, done


def inventory():
    # SOCK_DIAG_BY_FAMILY + NLM_F_REQUEST|NLM_F_DUMP; NAME and PEER attributes.
    request = struct.pack("=BBHIIIII", socket.AF_UNIX, 0, 0, 0xFFFFFFFF, 0, 5, 0xFFFFFFFF, 0xFFFFFFFF)
    header = struct.pack("=IHHII", 16 + len(request), 20, 0x301, 1, 0)
    result = []
    with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 4) as channel:
        channel.settimeout(2)
        channel.sendto(header + request, (0, 0))
        while True:
            data, _, flags, address = channel.recvmsg(1024 * 1024)
            if address[0] != 0 or flags & socket.MSG_TRUNC:
                raise ValueError("Untrusted/truncated kernel response")
            rows, done = parse_messages(data)
            result.extend(rows)
            if done:
                return result


if __name__ == "__main__":
    # Deterministic parser tests never open a netlink socket.
    if sys.argv[1:] == ["--parse-fixture"]:
        print(json.dumps(parse_messages(sys.stdin.buffer.read())))
    elif not sys.argv[1:]:
        print(json.dumps(inventory()))
    else:
        raise ValueError("Unsupported socket evidence invocation")
