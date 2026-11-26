#!/usr/bin/env python3
"""
NX-OS NAND (.bin) Parser, Inspector, Verifier & Modifier
--------------------------------------------------------
Standard-library-only Python 3 tool for parsing, verifying, inspecting, and
modifying full `NXND` raw NAND dumps exported from the Horizon-NX Simulator.

Usage examples:
  python3 scripts/nx_nand_tool.py verify rawnand.bin
  python3 scripts/nx_nand_tool.py info rawnand.bin
  python3 scripts/nx_nand_tool.py inspect rawnand.bin
  python3 scripts/nx_nand_tool.py list rawnand.bin SYSTEM
  python3 scripts/nx_nand_tool.py extract rawnand.bin ./unpacked_nand
  python3 scripts/nx_nand_tool.py set-prodinfo rawnand.bin mod.bin --serial XAW90012345678 --region JPN
  python3 scripts/nx_nand_tool.py set-theme rawnand.bin mod.bin dark --bg-canvas "#101828" --focus-cyan "#38BDF8"
  python3 scripts/nx_nand_tool.py set-settings rawnand.bin mod.bin --theme dark --nickname "DevSwitch"
  python3 scripts/nx_nand_tool.py set-os rawnand.bin mod.bin --codename "Horizon-Mod"
  python3 scripts/nx_nand_tool.py replace-file rawnand.bin mod.bin SYSTEM /sys/applets/qlaunch.bin ./custom_qlaunch.bin
  python3 scripts/nx_nand_tool.py corrupt rawnand.bin bricked.bin BOOT1 --offset 64 --bytes 16
"""

from __future__ import annotations

import argparse
import hashlib
import struct
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple


# ============================================================================
# Binary & Cryptographic Helpers
# ============================================================================

def calc_crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def sha256_bytes(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def master_key_digest(revision: int) -> bytes:
    return sha256_bytes(f"NX-HOS-MASTER-KEY-REV:{revision}".encode("utf-8"))


def master_key_hash_hex(revision: int) -> str:
    return master_key_digest(revision)[:10].hex().upper()


def verify_trailing_crc32(data: bytes, label: str) -> bytes:
    if len(data) < 8:
        raise ValueError(f"{label} truncated (< 8 bytes)")
    payload, stored = data[:-4], struct.unpack_from("<I", data, len(data) - 4)[0]
    actual = calc_crc32(payload)
    if stored != actual:
        raise ValueError(
            f"{label} CRC32 mismatch: expected 0x{stored:08X}, got 0x{actual:08X}"
        )
    return payload


def with_trailing_crc32(payload: bytes) -> bytes:
    return payload + struct.pack("<I", calc_crc32(payload))


def pack_fixed_str(s: str, width: int) -> bytes:
    raw = s.encode("utf-8")[:width]
    return raw.ljust(width, b"\x00")


def unpack_fixed_str(raw: bytes) -> str:
    zero = raw.find(b"\x00")
    return (raw[:zero] if zero >= 0 else raw).decode("utf-8", errors="replace")


def pack_var_str(s: str) -> bytes:
    raw = s.encode("utf-8")
    return struct.pack("<I", len(raw)) + raw


def unpack_var_str(buf: bytes, pos: int) -> Tuple[str, int]:
    if pos + 4 > len(buf):
        raise ValueError("Truncated varstring length")
    length = struct.unpack_from("<I", buf, pos)[0]
    pos += 4
    if pos + length > len(buf):
        raise ValueError("Truncated varstring payload")
    s = buf[pos : pos + length].decode("utf-8", errors="replace")
    return s, pos + length


def pack_rgb_hex(hex_str: str) -> bytes:
    clean = hex_str.lstrip("#").ljust(6, "0")
    return bytes(
        [
            int(clean[0:2], 16),
            int(clean[2:4], 16),
            int(clean[4:6], 16),
        ]
    )


def unpack_rgb_hex(raw: bytes) -> str:
    return f"#{raw[0]:02X}{raw[1]:02X}{raw[2]:02X}"


# ============================================================================
# Outer NXND Container & NXFS v2 Filesystem
# ============================================================================

REQUIRED_BY_MAP = {0: "STAGE1", 1: "STAGE2", 2: "OS_HOME"}
REQUIRED_BY_REV = {v: k for k, v in REQUIRED_BY_MAP.items()}


@dataclass
class PartitionRecord:
    id: str
    gpt_index: int
    encrypted: bool
    required_by: int
    virtual_capacity_bytes: float
    start_lba: int
    end_lba: int
    label: str
    description: str
    raw_image: bytes


@dataclass
class NandDump:
    version: int
    timestamp: float
    partitions: List[PartitionRecord]

    def get_partition(self, pid: str) -> PartitionRecord:
        for p in self.partitions:
            if p.id == pid:
                return p
        raise KeyError(f"Partition '{pid}' not found in NAND dump")


def parse_nxnd(raw: bytes) -> NandDump:
    body = verify_trailing_crc32(raw, "NXND container")
    if len(body) < 20 or body[:4] != b"NXND":
        raise ValueError(f"Invalid magic {body[:4]!r} (expected b'NXND')")
    version, timestamp, count = struct.unpack_from("<IdI", body, 4)
    if version != 1:
        raise ValueError(f"Unsupported NXND version {version}")
    if count == 0 or count > 32:
        raise ValueError(f"Invalid partition count {count}")

    pos = 20
    partitions: List[PartitionRecord] = []
    for _ in range(count):
        if pos + 35 > len(body):
            raise ValueError("Truncated NXND partition header")
        pid = unpack_fixed_str(body[pos : pos + 16])
        pos += 16
        gpt_idx, enc, req_by = struct.unpack_from("<BBB", body, pos)
        pos += 3
        virt_cap, start_lba, end_lba = struct.unpack_from("<dII", body, pos)
        pos += 16
        label, pos = unpack_var_str(body, pos)
        desc, pos = unpack_var_str(body, pos)
        raw_len = struct.unpack_from("<I", body, pos)[0]
        pos += 4
        if end_lba < start_lba or raw_len > virt_cap:
            raise ValueError(f"Invalid GPT/size bounds on partition {pid}")
        if pos + raw_len > len(body):
            raise ValueError(f"Partition {pid} raw image truncated")
        raw_img = body[pos : pos + raw_len]
        pos += raw_len
        partitions.append(
            PartitionRecord(
                id=pid,
                gpt_index=gpt_idx,
                encrypted=bool(enc),
                required_by=req_by,
                virtual_capacity_bytes=virt_cap,
                start_lba=start_lba,
                end_lba=end_lba,
                label=label,
                description=desc,
                raw_image=raw_img,
            )
        )

    if pos != len(body):
        raise ValueError(
            f"NXND container has trailing unparsed bytes (pos={pos}, body={len(body)})"
        )
    return NandDump(version=version, timestamp=timestamp, partitions=partitions)


def pack_nxnd(dump: NandDump) -> bytes:
    out = bytearray()
    out += b"NXND"
    out += struct.pack("<IdI", dump.version, dump.timestamp, len(dump.partitions))
    for p in dump.partitions:
        out += pack_fixed_str(p.id, 16)
        out += struct.pack("<BBB", p.gpt_index, 1 if p.encrypted else 0, p.required_by)
        out += struct.pack("<dII", p.virtual_capacity_bytes, p.start_lba, p.end_lba)
        out += pack_var_str(p.label)
        out += pack_var_str(p.description)
        out += struct.pack("<I", len(p.raw_image))
        out += p.raw_image
    return with_trailing_crc32(bytes(out))


def unpack_nxfs(image: bytes) -> Dict[str, bytes]:
    if len(image) < 16:
        raise ValueError("NXFS image truncated (< 16 bytes)")
    if image[:4] != b"NXFS":
        raise ValueError(f"Invalid NXFS magic {image[:4]!r}")
    version, entry_count, expected_payload_crc = struct.unpack_from("<III", image, 4)
    if version != 2:
        raise ValueError(f"Unsupported NXFS version {version} (expected 2)")

    pos = 16
    entries: List[Tuple[str, int, int, int]] = []
    for _ in range(entry_count):
        path_len = struct.unpack_from("<H", image, pos)[0]
        pos += 2
        path = image[pos : pos + path_len].decode("utf-8")
        pos += path_len
        offset, length, file_crc = struct.unpack_from("<III", image, pos)
        pos += 12
        entries.append((path, offset, length, file_crc))

    payload = image[pos:]
    actual_payload_crc = calc_crc32(payload)
    if actual_payload_crc != expected_payload_crc:
        raise ValueError(
            f"NXFS payload CRC32 mismatch: expected 0x{expected_payload_crc:08X}, "
            f"got 0x{actual_payload_crc:08X}"
        )

    files: Dict[str, bytes] = {}
    for path, offset, length, file_crc in entries:
        chunk = payload[offset : offset + length]
        if len(chunk) != length:
            raise ValueError(f"NXFS file '{path}' truncated")
        if calc_crc32(chunk) != file_crc:
            raise ValueError(f"NXFS file '{path}' failed CRC32 verification")
        files[path] = chunk
    return files


def pack_nxfs(files: Dict[str, bytes]) -> bytes:
    sorted_paths = sorted(files.keys())
    table = bytearray()
    payload = bytearray()
    offset = 0
    for path in sorted_paths:
        data = files[path]
        p_bytes = path.encode("utf-8")
        table += struct.pack("<H", len(p_bytes)) + p_bytes
        table += struct.pack("<III", offset, len(data), calc_crc32(data))
        payload += data
        offset += len(data)

    header = b"NXFS" + struct.pack(
        "<III", 2, len(sorted_paths), calc_crc32(bytes(payload))
    )
    return header + bytes(table) + bytes(payload)


# ============================================================================
# Binary Struct Parsers / Serializers
# ============================================================================

REGIONS = ["USA", "JPN", "EUR"]
SKUS = ["HAC-001", "HAC-001(-01)", "HEG-001"]
WAVE_TYPES = ["sine", "triangle", "square"]
SFX_KEYS = ["tick", "select", "back", "launch", "click", "modal", "error", "sleep"]
GLYPHS = ["star", "gamepad", "flame", "leaf"]
CAT_ENUM = ["game", "homebrew", "tool", "cartridge"]
RUNNER_ENUM = ["stellar", "blocks", "chromatic", "hex", "sketch", "cartridge", "trivia"]


def decode_bct0(data: bytes) -> dict:
    if len(data) < 1024 or data[:4] != b"BCT0":
        raise ValueError("Invalid BCT0 header or size (< 1024 bytes)")
    stored_crc = struct.unpack_from("<I", data, 1020)[0]
    actual_crc = calc_crc32(data[:1020])
    if stored_crc != actual_crc:
        raise ValueError(f"BCT0 CRC32 mismatch: 0x{stored_crc:08X} != 0x{actual_crc:08X}")
    bct_ver, entry_pt, load_addr, stg1_size, dram_mhz, dev_type, hash_alg = struct.unpack_from(
        "<7I", data, 4
    )
    return {
        "bctVersion": f"0x{bct_ver:08X}",
        "entryPoint": f"0x{entry_pt:08X}",
        "entryPointInt": entry_pt,
        "loadAddr": f"0x{load_addr:08X}",
        "stage1Size": stg1_size,
        "dramMhz": dram_mhz,
        "bootDevice": dev_type,
        "hashAlg": hash_alg,
        "serialHint": unpack_fixed_str(data[0x20:0x40]),
        "hwIdSha256": data[0xE0:0x100],
        "keyblobSha256": data[0x100:0x120],
        "boot1Sha256": data[0x120:0x140],
        "buildTag": unpack_fixed_str(data[0x200:0x220]),
    }


def decode_nx_boot1(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "BOOT0 NX_BOOT1")
    if len(body) < 112 or body[:8] != b"NX_BOOT1":
        raise ValueError("Invalid NX_BOOT1 signature")
    entry_pt, build_ver, dram_mb, sec_flags = struct.unpack_from("<4I", body, 8)
    target_part = unpack_fixed_str(body[0x18:0x28])
    target_path = unpack_fixed_str(body[0x28:0x48])
    stg2_addr, stg2_size = struct.unpack_from("<II", body, 0x48)
    stg2_sha256 = body[0x50:0x70]
    return {
        "entryPoint": f"0x{entry_pt:08X}",
        "entryPointInt": entry_pt,
        "buildVer": f"0x{build_ver:08X}",
        "dramSizeMb": dram_mb,
        "securityFlags": sec_flags,
        "stage2Partition": target_part,
        "stage2Path": target_path,
        "stage2LoadAddr": f"0x{stg2_addr:08X}",
        "stage2LoadAddrInt": stg2_addr,
        "stage2Size": stg2_size,
        "stage2Sha256": stg2_sha256,
        "byteSize": len(data),
    }


def decode_stg1(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "BOOT0 STG1")
    if body[:4] != b"STG1":
        raise ValueError("Invalid STG1 magic")
    stg, dram_init, bct_ver, entry_pt = struct.unpack_from("<BBHI", body, 4)
    target = unpack_fixed_str(body[12:28])
    boot1_size = struct.unpack_from("<I", body, 28)[0]
    boot1_sha = body[32:64]
    return {
        "stage": stg,
        "dramInitialized": bool(dram_init),
        "bctVer": bct_ver,
        "entryPoint": entry_pt,
        "target": target,
        "boot1Size": boot1_size,
        "boot1Sha256": boot1_sha,
    }


def decode_pk21(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "BOOT1 PK21")
    if len(body) < 48 or body[:4] != b"PK21":
        raise ValueError("Invalid PK21 magic")
    kernel_entry, ver_raw, kip_count = struct.unpack_from("<III", body, 4)
    maj = (ver_raw >> 16) & 0xFF
    min_v = (ver_raw >> 8) & 0xFF
    pat = ver_raw & 0xFF
    kip_part = unpack_fixed_str(body[0x10:0x18])
    sys_part = unpack_fixed_str(body[0x18:0x20])
    usr_part = unpack_fixed_str(body[0x20:0x28])
    safe_part = unpack_fixed_str(body[0x28:0x30])
    manifest = []
    pos = 0x30
    for _ in range(kip_count):
        k_name = unpack_fixed_str(body[pos : pos + 16])
        k_size = struct.unpack_from("<I", body, pos + 16)[0]
        k_sha = body[pos + 20 : pos + 52]
        manifest.append({"name": k_name, "size": k_size, "sha256": k_sha})
        pos += 52
    return {
        "kernelEntry": f"0x{kernel_entry:08X}",
        "kernelEntryInt": kernel_entry,
        "osVersion": f"{maj}.{min_v}.{pat}",
        "kipCount": kip_count,
        "mounts": [kip_part, sys_part, usr_part, safe_part],
        "manifest": manifest,
        "byteSize": len(data),
    }


def decode_stg2(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "BOOT1 STG2")
    if body[:4] != b"STG2":
        raise ValueError("Invalid STG2 magic")
    stg, kip_count, _, kernel_entry = struct.unpack_from("<BBHI", body, 4)
    tag = unpack_fixed_str(body[12:20])
    pkg2_size = struct.unpack_from("<I", body, 20)[0]
    pkg2_sha = body[24:56]
    return {
        "stage": stg,
        "kipCount": kip_count,
        "kernelEntry": kernel_entry,
        "tag": tag,
        "pkg2Size": pkg2_size,
        "pkg2Sha256": pkg2_sha,
    }


def decode_kip1(data: bytes, label: str = "BCPKG2 KIP1") -> dict:
    body = verify_trailing_crc32(data, label)
    if body[:4] != b"KIP1":
        raise ValueError(f"Invalid KIP1 magic on {label}")
    name = unpack_fixed_str(body[4:16])
    title_id = unpack_fixed_str(body[16:32])
    flags, prio, aff, fmt_ver = struct.unpack_from("<IBBH", body, 32)
    return {
        "name": name,
        "titleId": title_id,
        "flags": f"0x{flags:08X}",
        "priority": prio,
        "affinity": aff,
        "version": f"0x{fmt_ver:04X}",
        "byteSize": len(data),
    }


def decode_cal0(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "PRODINFO CAL0")
    if body[:4] != b"CAL0":
        raise ValueError("Invalid CAL0 magic")
    ver, fuses, reg_idx, sku_idx = struct.unpack_from("<HBBB", body, 4)
    mac = ":".join(f"{b:02X}" for b in body[9:15])
    serial = unpack_fixed_str(body[15:39])
    board = unpack_fixed_str(body[39:59])
    mkey = unpack_fixed_str(body[59:91])
    lcd = unpack_fixed_str(body[91:123])
    return {
        "version": ver,
        "fuseCount": fuses,
        "region": REGIONS[reg_idx] if reg_idx < len(REGIONS) else "USA",
        "sku": SKUS[sku_idx] if sku_idx < len(SKUS) else "HAC-001(-01)",
        "macAddress": mac,
        "serial": serial,
        "boardRevision": board,
        "masterKeyHash": mkey,
        "lcdProfile": lcd,
    }


def encode_cal0(p: dict) -> bytes:
    mac_bytes = bytes(int(h, 16) for h in p["macAddress"].split(":"))
    out = bytearray()
    out += b"CAL0"
    out += struct.pack(
        "<HBBB",
        p.get("version", 1),
        int(p["fuseCount"]),
        REGIONS.index(p["region"]),
        SKUS.index(p["sku"]),
    )
    out += mac_bytes[:6].ljust(6, b"\x00")
    out += pack_fixed_str(p["serial"], 24)
    out += pack_fixed_str(p["boardRevision"], 20)
    out += pack_fixed_str(p["masterKeyHash"], 32)
    out += pack_fixed_str(p["lcdProfile"], 32)
    return with_trailing_crc32(bytes(out))


def decode_kb00(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "PRODINFO KB00")
    if body[:4] != b"KB00":
        raise ValueError("Invalid KB00 magic")
    ver, key_count = struct.unpack_from("<HH", body, 4)
    pos = 8
    master_digests: List[bytes] = []
    if ver >= 2:
        for _ in range(key_count):
            pos += 1  # revision byte
            master_digests.append(body[pos : pos + 32])
            pos += 32
        pkg1_sha = body[pos : pos + 32]
        pos += 32
        pkg2_sha = body[pos : pos + 32]
        pos += 32
        rsa_bits, rsa_exp = struct.unpack_from("<II", body, pos)
        return {
            "version": ver,
            "masterKeyRevisions": key_count,
            "pkg1Sha256": pkg1_sha,
            "pkg2Sha256": pkg2_sha,
            "rsaBits": rsa_bits,
            "rsaExponent": rsa_exp,
            "masterKeyDigests": master_digests,
            "keyBlobBytes": len(body),
        }
    return {
        "version": ver,
        "masterKeyRevisions": key_count,
        "pkg1Sha256": b"",
        "pkg2Sha256": b"",
        "keyBlobBytes": len(body),
    }


def build_kb00_v2(prod_info: dict, nx_boot1_bytes: bytes, pk21_bytes: bytes) -> bytes:
    out = bytearray()
    out += b"KB00"
    out += struct.pack("<HH", 2, 19)
    for rev in range(19):
        out += struct.pack("<B", rev)
        out += master_key_digest(rev)
    out += sha256_bytes(nx_boot1_bytes)
    out += sha256_bytes(pk21_bytes)
    seed = f"{prod_info['serial']}|{prod_info['macAddress']}|{prod_info['boardRevision']}"
    out += struct.pack("<II", 2048, 65537)
    out += sha256_bytes(f"{seed}|RSA2048_MODULUS".encode("utf-8"))
    out += sha256_bytes(f"{seed}|ECC_P256_QX".encode("utf-8"))
    out += sha256_bytes(f"{seed}|ECC_P256_QY".encode("utf-8"))
    out += sha256_bytes(
        f"{seed}|{prod_info['region']}|{prod_info['sku']}|SSL_CLIENT_V18".encode("utf-8")
    )
    return with_trailing_crc32(bytes(out))


def decode_tcal(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "PRODINFO TCAL")
    if body[:4] != b"TCAL":
        raise ValueError("Invalid TCAL magic")
    w, h, pts, jitter = struct.unpack_from("<HHBB", body, 4)
    return {
        "panelResolution": f"{w}x{h}",
        "maxTouchPoints": pts,
        "jitterFilter": bool(jitter),
    }


def decode_acal(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "PRODINFO ACAL")
    if body[:4] != b"ACAL":
        raise ValueError("Invalid ACAL magic")
    codec = unpack_fixed_str(body[4:12])
    hp_limit, spk_boost, dsp_noise = struct.unpack_from("<BBB", body, 12)
    return {
        "codec": codec,
        "headphoneLimitDb": hp_limit,
        "speakerBoostGainDb": spk_boost,
        "noiseCancellation": bool(dsp_noise),
    }


def decode_ical(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "PRODINFO ICAL")
    if body[:4] != b"ICAL":
        raise ValueError("Invalid ICAL magic")
    sensor = unpack_fixed_str(body[4:12])
    ax, ay, az, gx, gy, gz = struct.unpack_from("<ffffff", body, 12)
    return {
        "sensor": sensor,
        "accelZeroG": f"({ax:.4f}, {ay:.4f}, {az:.4f})",
        "gyroDrift": f"({gx:.5f}, {gy:.5f}, {gz:.5f})",
    }


def decode_fca0(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "PRODINFOF FCA0")
    if body[:4] != b"FCA0":
        raise ValueError("Invalid FCA0 magic")
    lg, rg, mah, en = struct.unpack_from("<ffHB", body, 4)
    model = unpack_fixed_str(body[15:31])
    return {
        "railModel": model,
        "gainLR": f"({lg:.2f}, {rg:.2f})",
        "batteryCapacityMah": mah,
        "railsEnabled": bool(en),
    }


def decode_bat0(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "PRODINFOF BAT0")
    if body[:4] != b"BAT0":
        raise ValueError("Invalid BAT0 magic")
    model = unpack_fixed_str(body[4:16])
    mah, wh_x10, nom_mv, max_mv, cut_mv, cycles, r_mohm = struct.unpack_from(
        "<HHHHHHH", body, 16
    )
    return {
        "batteryModel": model,
        "capacityMah": mah,
        "wattHours": wh_x10 / 10.0,
        "nominalMv": nom_mv,
        "maxChargeMv": max_mv,
        "cutoffMv": cut_mv,
        "factoryCycles": cycles,
        "internalResistanceMohm": r_mohm,
    }


def decode_safe(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "SAFE recovery")
    if body[:4] != b"SAFE":
        raise ValueError("Invalid SAFE magic")
    ver, min_ver, res, flags = struct.unpack_from("<4B", body, 4)
    mode = unpack_fixed_str(body[8:32])
    return {"version": ver, "minor": min_ver, "flags": flags, "mode": mode}


def decode_rfui(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "SAFE RFUI")
    if body[:4] != b"RFUI":
        raise ValueError("Invalid RFUI magic")
    tag = unpack_fixed_str(body[4:28])
    count = body[28]
    opts = []
    pos = 29
    for _ in range(count):
        opts.append(unpack_fixed_str(body[pos : pos + 32]))
        pos += 32
    return {"menuTag": tag, "options": opts}


def decode_hosm(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "SYSTEM HOSM")
    if body[:4] != b"HOSM":
        raise ValueError("Invalid HOSM magic")
    maj, min_v, pat, kip_count = struct.unpack_from("<BBBB", body, 4)
    codename = unpack_fixed_str(body[8:32])
    build_hash = unpack_fixed_str(body[32:56])
    kernel_entry = struct.unpack_from("<I", body, 56)[0]
    home_id = unpack_fixed_str(body[60:80])
    splash_color = unpack_rgb_hex(body[80:83])
    splash_accent = unpack_rgb_hex(body[83:86])
    kips = []
    pos = 86
    for _ in range(kip_count):
        kips.append(unpack_fixed_str(body[pos : pos + 16]))
        pos += 16
    return {
        "osVersion": f"{maj}.{min_v}.{pat}",
        "codename": codename,
        "buildHash": build_hash,
        "kernelEntry": f"0x{kernel_entry:08X}",
        "kernelEntryInt": kernel_entry,
        "homeAppletId": home_id,
        "splashColor": splash_color,
        "splashAccent": splash_accent,
        "requiredKips": kips,
    }


def encode_hosm(m: dict) -> bytes:
    maj, min_v, pat = [int(x) for x in m["osVersion"].split(".")[:3]]
    kips = m["requiredKips"]
    out = bytearray()
    out += b"HOSM"
    out += struct.pack("<BBBB", maj, min_v, pat, len(kips))
    out += pack_fixed_str(m["codename"], 24)
    out += pack_fixed_str(m["buildHash"], 24)
    out += struct.pack("<I", int(m["kernelEntry"], 16))
    out += pack_fixed_str(m["homeAppletId"], 20)
    out += pack_rgb_hex(m["splashColor"])
    out += pack_rgb_hex(m["splashAccent"])
    for k in kips:
        out += pack_fixed_str(k, 16)
    return with_trailing_crc32(bytes(out))


def decode_qapp(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "SYSTEM QAPP")
    if body[:4] != b"QAPP":
        raise ValueError("Invalid QAPP magic")
    slots, applets = struct.unpack_from("<HH", body, 4)
    title_id = unpack_fixed_str(body[8:28])
    name = unpack_fixed_str(body[28:44])
    return {"gridSlots": slots, "systemApplets": applets, "titleId": title_id, "name": name}


def decode_str0(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "SYSTEM STR0")
    if body[:4] != b"STR0":
        raise ValueError("Invalid STR0 magic")
    count = struct.unpack_from("<H", body, 4)[0]
    pos = 6
    entries = {}
    for _ in range(count):
        key = unpack_fixed_str(body[pos : pos + 16])
        pos += 16
        val, pos = unpack_var_str(body, pos)
        entries[key] = val
    return entries


def decode_cap0(data: bytes) -> List[dict]:
    body = verify_trailing_crc32(data, "SYSTEM CAP0")
    if body[:4] != b"CAP0":
        raise ValueError("Invalid CAP0 magic")
    count = struct.unpack_from("<H", body, 4)[0]
    pos = 6
    caps = []
    for _ in range(count):
        tid = unpack_fixed_str(body[pos : pos + 20])
        pos += 20
        flags = struct.unpack_from("<I", body, pos)[0]
        pos += 4
        name = unpack_fixed_str(body[pos : pos + 24])
        pos += 24
        caps.append({"titleId": tid, "flags": flags, "name": name})
    return caps


THEME_COLOR_FIELDS = [
    "bgCanvas",
    "bgHeader",
    "bgTile",
    "bgTileEmpty",
    "bgAppletBtn",
    "bgModal",
    "textPrimary",
    "textSecondary",
    "borderHairline",
    "focusCyan",
]


def decode_thm0(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "SYSTEM THM0")
    if body[:4] != b"THM0":
        raise ValueError("Invalid THM0 magic")
    tid = "dark" if body[4] == 1 else "light"
    name = unpack_fixed_str(body[5:29])
    res = {"id": tid, "name": name}
    pos = 29
    for field in THEME_COLOR_FIELDS:
        res[field] = unpack_rgb_hex(body[pos : pos + 3])
        pos += 3
    return res


def encode_thm0(t: dict) -> bytes:
    out = bytearray()
    out += b"THM0"
    out += struct.pack("<B", 1 if t["id"] == "dark" else 0)
    out += pack_fixed_str(t["name"], 24)
    for field in THEME_COLOR_FIELDS:
        out += pack_rgb_hex(t[field])
    return with_trailing_crc32(bytes(out))


def decode_set0(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "USER SET0")
    if body[:4] != b"SET0":
        raise ValueError("Invalid SET0 magic")
    theme, c24, air, bright, vol, muted, sleep_m, docked = struct.unpack_from(
        "<8B", body, 4
    )
    return {
        "theme": "dark" if theme == 1 else "light",
        "clock24h": bool(c24),
        "airplaneMode": bool(air),
        "brightness": bright,
        "volume": vol,
        "muted": bool(muted),
        "autoSleepMinutes": sleep_m,
        "dockedMode": bool(docked),
        "nickname": unpack_fixed_str(body[12:44]),
        "wifiSsid": unpack_fixed_str(body[44:76]),
        "activeUserId": unpack_fixed_str(body[76:92]),
    }


def encode_set0(s: dict) -> bytes:
    out = bytearray()
    out += b"SET0"
    out += struct.pack(
        "<8B",
        1 if s["theme"] == "dark" else 0,
        1 if s["clock24h"] else 0,
        1 if s["airplaneMode"] else 0,
        int(s["brightness"]),
        int(s["volume"]),
        1 if s["muted"] else 0,
        int(s["autoSleepMinutes"]),
        1 if s["dockedMode"] else 0,
    )
    out += pack_fixed_str(s["nickname"], 32)
    out += pack_fixed_str(s["wifiSsid"], 32)
    out += pack_fixed_str(s["activeUserId"], 16)
    return with_trailing_crc32(bytes(out))


def decode_prf0(data: bytes) -> List[dict]:
    body = verify_trailing_crc32(data, "USER PRF0")
    if body[:4] != b"PRF0":
        raise ValueError("Invalid PRF0 magic")
    count = struct.unpack_from("<H", body, 4)[0]
    pos = 6
    out = []
    for _ in range(count):
        uid = unpack_fixed_str(body[pos : pos + 16])
        pos += 16
        name = unpack_fixed_str(body[pos : pos + 24])
        pos += 24
        bg = unpack_rgb_hex(body[pos : pos + 3])
        pos += 3
        glyph_idx = body[pos]
        pos += 1
        hours = struct.unpack_from("<I", body, pos)[0]
        pos += 4
        fc = unpack_fixed_str(body[pos : pos + 20])
        pos += 20
        out.append(
            {
                "id": uid,
                "name": name,
                "avatarBg": bg,
                "avatarGlyph": GLYPHS[glyph_idx] if glyph_idx < len(GLYPHS) else "gamepad",
                "playHoursTotal": hours,
                "friendCode": fc,
            }
        )
    return out


def decode_tit0(data: bytes) -> List[dict]:
    body = verify_trailing_crc32(data, "USER TIT0")
    if body[:4] != b"TIT0":
        raise ValueError("Invalid TIT0 magic")
    count = struct.unpack_from("<H", body, 4)[0]
    pos = 6
    titles = []
    for _ in range(count):
        tid, pos = unpack_var_str(body, pos)
        title, pos = unpack_var_str(body, pos)
        pub, pos = unpack_var_str(body, pos)
        ver, pos = unpack_var_str(body, pos)
        cat_idx = body[pos]
        pos += 1
        art_id, pos = unpack_var_str(body, pos)
        run_idx = body[pos]
        pos += 1
        size_mb, play_min, last_played = struct.unpack_from("<IId", body, pos)
        pos += 16
        has_hs = body[pos] == 1
        pos += 1
        hs_val = struct.unpack_from("<I", body, pos)[0]
        pos += 4
        save_path, pos = unpack_var_str(body, pos)
        pinned_order, is_card = struct.unpack_from("<HB", body, pos)
        pos += 3
        titles.append(
            {
                "id": tid,
                "title": title,
                "publisher": pub,
                "version": ver,
                "category": CAT_ENUM[cat_idx] if cat_idx < len(CAT_ENUM) else "game",
                "artworkId": art_id,
                "runnerType": RUNNER_ENUM[run_idx] if run_idx < len(RUNNER_ENUM) else "stellar",
                "sizeMb": size_mb,
                "playMinutes": play_min,
                "lastPlayed": last_played,
                "highScore": hs_val if has_hs else None,
                "saveFilePath": save_path,
                "pinnedOrder": pinned_order,
                "isGameCard": bool(is_card),
            }
        )
    return titles


def decode_save(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "USER SAVE")
    if body[:4] != b"SAVE":
        raise ValueError("Invalid SAVE magic")
    title_id = unpack_fixed_str(body[4:20])
    score, play_min, last_saved = struct.unpack_from("<IId", body, 20)
    flags = body[36] if len(body) > 36 else 0x01
    profile_id = unpack_fixed_str(body[37:53]) if len(body) >= 53 else "usr-1"
    return {
        "titleId": title_id,
        "highScore": score,
        "playMinutes": play_min,
        "lastSavedAt": last_saved,
        "valid": (flags & 0x01) == 0x01,
        "hasHighScore": (flags & 0x02) == 0x02,
        "profileId": profile_id,
    }


def decode_art0(data: bytes) -> List[dict]:
    body = verify_trailing_crc32(data, "SYSTEM ART0")
    if body[:4] != b"ART0":
        raise ValueError("Invalid ART0 magic")
    count = struct.unpack_from("<H", body, 4)[0]
    pos = 6
    items = []
    for _ in range(count):
        aid = unpack_fixed_str(body[pos : pos + 16])
        pos += 16
        w, h, blen = struct.unpack_from("<HHI", body, pos)
        pos += 8
        svg_raw = body[pos : pos + blen]
        pos += blen
        if not svg_raw.startswith(b"<svg"):
            raise ValueError(f"ART0 asset '{aid}' is not an SVG payload")
        items.append({"id": aid, "width": w, "height": h, "bytes": blen})
    return items


def decode_gly0(data: bytes) -> List[dict]:
    body = verify_trailing_crc32(data, "SYSTEM GLY0")
    if body[:4] != b"GLY0":
        raise ValueError("Invalid GLY0 magic")
    count = struct.unpack_from("<H", body, 4)[0]
    pos = 6
    items = []
    for _ in range(count):
        gid = unpack_fixed_str(body[pos : pos + 16])
        pos += 16
        blen = struct.unpack_from("<I", body, pos)[0]
        pos += 4
        svg_raw = body[pos : pos + blen]
        pos += blen
        if not svg_raw.startswith(b"<svg"):
            raise ValueError(f"GLY0 glyph '{gid}' is not an SVG payload")
        items.append({"id": gid, "bytes": blen})
    return items


def decode_spl0(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "SYSTEM SPL0")
    if body[:4] != b"SPL0":
        raise ValueError("Invalid SPL0 magic")
    caption = unpack_fixed_str(body[4:36])
    bg = unpack_rgb_hex(body[36:39])
    accent = unpack_rgb_hex(body[39:42])
    blen = struct.unpack_from("<I", body, 42)[0]
    svg_raw = body[46 : 46 + blen]
    if not svg_raw.startswith(b"<svg"):
        raise ValueError("SPL0 splash is not an SVG payload")
    return {"caption": caption, "bgColor": bg, "accentColor": accent, "bytes": blen}


def decode_spr0(data: bytes) -> List[dict]:
    body = verify_trailing_crc32(data, "SYSTEM SPR0")
    if body[:4] != b"SPR0":
        raise ValueError("Invalid SPR0 magic")
    count = struct.unpack_from("<H", body, 4)[0]
    pos = 6
    sprites = []
    for _ in range(count):
        sid = unpack_fixed_str(body[pos : pos + 16])
        pos += 16
        w, h, blen = struct.unpack_from("<HHI", body, pos)
        pos += 8
        rgba = body[pos : pos + blen]
        pos += blen
        if len(rgba) != w * h * 4:
            raise ValueError(f"SPR0 '{sid}' RGBA length mismatch ({len(rgba)} != {w*h*4})")
        sprites.append({"id": sid, "width": w, "height": h, "bytes": blen})
    return sprites


def decode_seq0(data: bytes) -> List[dict]:
    body = verify_trailing_crc32(data, "SYSTEM SEQ0")
    if body[:4] != b"SEQ0":
        raise ValueError("Invalid SEQ0 magic")
    count = struct.unpack_from("<H", body, 4)[0]
    pos = 6
    notes = []
    for _ in range(count):
        freq, start_ms, dur_ms, widx, gain_milli = struct.unpack_from("<HHHBB", body, pos)
        pos += 8
        notes.append({
            "freqHz": freq,
            "startMs": start_ms,
            "durationMs": dur_ms,
            "wave": WAVE_TYPES[widx] if widx < len(WAVE_TYPES) else "sine",
            "gain": gain_milli / 1000.0,
        })
    return notes


def decode_stlr(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "SYSTEM STLR")
    if body[:4] != b"STLR":
        raise ValueError("Invalid STLR magic")
    ship_spd, bullet_spd, fire_ticks, spawn_ticks, pts = struct.unpack_from("<ffHHI", body, 4)
    return {
        "shipSpeed": round(ship_spd, 2),
        "bulletSpeed": round(bullet_spd, 2),
        "fireIntervalTicks": fire_ticks,
        "spawnIntervalTicks": spawn_ticks,
        "pointsPerRock": pts,
        "bgColor": unpack_rgb_hex(body[20:23]),
        "bulletColor": unpack_rgb_hex(body[23:26]),
    }


def decode_tet0(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "SYSTEM TET0")
    if body[:4] != b"TET0":
        raise ValueError("Invalid TET0 magic")
    drop_ms, lock_bonus, line_score, count = struct.unpack_from("<HHHB", body, 4)
    pos = 11
    shapes = []
    for _ in range(count):
        name = unpack_fixed_str(body[pos : pos + 12])
        pos += 12
        color = unpack_rgb_hex(body[pos : pos + 3])
        pos += 3
        rows, cols = struct.unpack_from("<BB", body, pos)
        pos += 2
        pos += rows * cols
        shapes.append({"name": name, "color": color, "rows": rows, "cols": cols})
    return {
        "dropIntervalMs": drop_ms,
        "lockBonus": lock_bonus,
        "lineScore": line_score,
        "shapes": shapes,
    }


def decode_chr0(data: bytes) -> List[dict]:
    body = verify_trailing_crc32(data, "SYSTEM CHR0")
    if body[:4] != b"CHR0":
        raise ValueError("Invalid CHR0 magic")
    count = body[4]
    pos = 5
    pads = []
    for _ in range(count):
        pid = body[pos]
        pos += 1
        label = unpack_fixed_str(body[pos : pos + 16])
        pos += 16
        color = unpack_rgb_hex(body[pos : pos + 3])
        pos += 3
        freq, dur = struct.unpack_from("<HH", body, pos)
        pos += 4
        pads.append({"id": pid, "label": label, "color": color, "freqHz": freq, "durationMs": dur})
    return pads


def decode_quz0(data: bytes, label: str = "NXFS QUZ0") -> dict:
    body = verify_trailing_crc32(data, label)
    if body[:4] != b"QUZ0":
        raise ValueError(f"Invalid QUZ0 magic on {label}")
    tid = unpack_fixed_str(body[4:24])
    title = unpack_fixed_str(body[24:60])
    ver = unpack_fixed_str(body[60:72])
    pts, qcount = struct.unpack_from("<HH", body, 72)
    pos = 76
    questions = []
    for _ in range(qcount):
        qtext, pos = unpack_var_str(body, pos)
        ans = body[pos]
        opt_count = body[pos + 1]
        pos += 2
        opts = []
        for _ in range(opt_count):
            opt, pos = unpack_var_str(body, pos)
            opts.append(opt)
        questions.append({"q": qtext, "opts": opts, "ans": ans})
    return {"titleId": tid, "title": title, "version": ver, "pointsPerCorrect": pts, "questions": questions}


def decode_nro0(data: bytes) -> dict:
    body = verify_trailing_crc32(data, "SYSTEM NRO0")
    if body[:4] != b"NRO0":
        raise ValueError("Invalid NRO0 magic")
    tid = unpack_fixed_str(body[4:24])
    name = unpack_fixed_str(body[24:40])
    entry, tsize, rsize, dsize, tcrc = struct.unpack_from("<5I", body, 40)
    pos = 60
    text_buf = body[pos : pos + tsize]
    pos += tsize
    if calc_crc32(text_buf) != tcrc:
        raise ValueError("NRO0 .text CRC32 mismatch")
    opcodes = list(struct.unpack_from(f"<{tsize // 4}I", text_buf))
    rodata_buf = body[pos : pos + rsize]
    pos += rsize
    symbols = [s for s in rodata_buf.decode("utf-8", errors="replace").split("\x00") if s]
    return {
        "titleId": tid,
        "name": name,
        "entryAddr": f"0x{entry:08X}",
        "textSize": tsize,
        "rodataSize": rsize,
        "dataSize": dsize,
        "textCrc32": f"0x{tcrc:08X}",
        "arm64Opcodes": opcodes,
        "symbols": symbols,
    }


def decode_and_exec_nxvm(data: bytes, regs: Dict[int, int]) -> dict:
    body = verify_trailing_crc32(data, "SYSTEM NXVM")
    if body[:4] != b"NXVM":
        raise ValueError("Invalid NXVM magic")
    abi, code_len = struct.unpack_from("<HH", body, 4)
    if abi != 1:
        raise ValueError(f"Unsupported NXVM ABI v{abi}")
    mod_name = unpack_fixed_str(body[8:32])
    code = body[32 : 32 + code_len]
    stack: List[int] = []
    outputs: Dict[int, int] = {}
    pc = 0
    steps = 0
    while pc < len(code) and steps < 512:
        op = code[pc]
        pc += 1
        steps += 1
        if op == 0xFF:
            break
        elif op == 0x01:
            val = struct.unpack_from("<i", code, pc)[0]
            pc += 4
            stack.append(val)
        elif op == 0x02:
            reg = code[pc]
            pc += 1
            stack.append(int(regs.get(reg, 0)))
        elif op == 0x10:
            b, a = stack.pop(), stack.pop()
            stack.append(a + b)
        elif op == 0x11:
            b, a = stack.pop(), stack.pop()
            stack.append(a - b)
        elif op == 0x12:
            b, a = stack.pop(), stack.pop()
            stack.append(a * b)
        elif op == 0x13:
            b, a = stack.pop(), stack.pop()
            stack.append(0 if b == 0 else int(a / b))
        elif op == 0x14:
            hi, lo, val = stack.pop(), stack.pop(), stack.pop()
            stack.append(max(lo, min(hi, val)))
        elif op == 0x20:
            slot = code[pc]
            pc += 1
            outputs[slot] = stack.pop()
        else:
            raise ValueError(f"NXVM illegal opcode 0x{op:02X}")
    return {
        "module": mod_name,
        "codeBytes": code_len,
        "instructionsExecuted": steps,
        "batteryPercent": outputs.get(0, 0),
        "estimatedMinutesLeft": outputs.get(1, 0),
        "healthPercent": outputs.get(2, 0),
    }


# ============================================================================
# Exhaustive Offline Cryptographic & Structural Verifier
# ============================================================================

def run_full_verification(dump: NandDump) -> List[Tuple[str, bool, str]]:
    results: List[Tuple[str, bool, str]] = []

    def record(name: str, passed: bool, detail: str) -> None:
        results.append((name, passed, detail))

    # 1. GPT & Honesty Checks
    parts = sorted(dump.partitions, key=lambda p: p.gpt_index)
    contiguous_ok = len(parts) == 8
    capacity_ok = True
    honesty_ok = True
    next_lba = 0
    for i, p in enumerate(parts):
        if p.gpt_index != i or p.start_lba != next_lba or p.end_lba < p.start_lba:
            contiguous_ok = False
        next_lba = p.end_lba + 1
        sector_bytes = (p.end_lba - p.start_lba + 1) * 512
        if sector_bytes != int(p.virtual_capacity_bytes) or len(p.raw_image) > sector_bytes:
            capacity_ok = False
        if p.encrypted:
            honesty_ok = False
    record(
        "GPT & Honesty",
        contiguous_ok and capacity_ok and honesty_ok,
        f"{len(parts)}/8 partitions · contiguous={contiguous_ok} · exact_LBA={capacity_ok} · encrypted=false={honesty_ok}",
    )

    # Unpack all NXFS images
    nxfs_map: Dict[str, Dict[str, bytes]] = {}
    for p in parts:
        try:
            nxfs_map[p.id] = unpack_nxfs(p.raw_image)
        except Exception as exc:
            record(f"NXFS ({p.id})", False, str(exc))
            return results

    # 2. BOOT0
    boot0 = nxfs_map["BOOT0"]
    bct = decode_bct0(boot0["/boot/bct.bin"])
    nx_boot1_bytes = boot0["/boot/nx_boot1.bin"]
    nx_boot1 = decode_nx_boot1(nx_boot1_bytes)
    stg1 = decode_stg1(boot0["/boot/stage1.hdr"])
    actual_boot1_sha = sha256_bytes(nx_boot1_bytes)

    boot0_ok = (
        nx_boot1["byteSize"] == bct["stage1Size"]
        and actual_boot1_sha == bct["boot1Sha256"]
        and nx_boot1["entryPointInt"] == bct["entryPointInt"]
        and stg1["entryPoint"] == bct["entryPointInt"]
        and stg1["target"] == "BOOT1"
        and stg1["boot1Size"] == len(nx_boot1_bytes)
        and stg1["boot1Sha256"] == actual_boot1_sha
    )
    record(
        "BOOT0 Chain",
        boot0_ok,
        f"BCT0->{nx_boot1['byteSize']}B NX_BOOT1 SHA-256={actual_boot1_sha[:6].hex()}.. STG1 ok={boot0_ok}",
    )

    # 3. PRODINFO
    prod = nxfs_map["PRODINFO"]
    cal = decode_cal0(prod["/cal/prodinfo.bin"])
    kb_bytes = prod.get("/cal/cal0_keyblob.bin") or prod.get("/cal/keyblob.bin")
    if not kb_bytes:
        raise ValueError("Missing /cal/cal0_keyblob.bin")
    kb = decode_kb00(kb_bytes)
    tcal = decode_tcal(prod["/cal/touch_cal.bin"])
    acal = decode_acal(prod["/cal/audio_cal.bin"])
    ical = decode_ical(prod["/cal/imu_cal.bin"])

    expected_hw_sha = sha256_bytes(
        f"NX-SE-ROOT:{cal['serial']}:{cal['boardRevision']}:{cal['macAddress']}".encode("utf-8")
    )
    kb_bct_match = sha256_bytes(kb_bytes) == bct["keyblobSha256"]
    kb_boot1_match = kb["pkg1Sha256"] == actual_boot1_sha
    serial_match = bct["serialHint"] == cal["serial"]
    hw_id_match = expected_hw_sha == bct["hwIdSha256"]
    mkey_match = cal["masterKeyHash"] == master_key_hash_hex(18)
    fuses_ok = cal["fuseCount"] == 19

    record(
        "PRODINFO Identity & Keys",
        kb_bct_match and kb_boot1_match and serial_match and hw_id_match and mkey_match and fuses_ok,
        f"serial={cal['serial']} ({serial_match}) · fuses={cal['fuseCount']}/19 ({fuses_ok}) · KB00<->BCT0={kb_bct_match} · hwID={hw_id_match} · rev18={mkey_match}",
    )
    record(
        "PRODINFO Sensors",
        bool(tcal and acal and ical),
        f"TCAL={tcal['panelResolution']} · ACAL={acal['codec']} · ICAL={ical['sensor']}",
    )

    # 4. BOOT1 (PK21 & STG2)
    boot1 = nxfs_map["BOOT1"]
    pk21_bytes = boot1["/pk21/package2.bin"]
    pk21 = decode_pk21(pk21_bytes)
    stg2 = decode_stg2(boot1["/pk21/stage2.hdr"])
    actual_pk21_sha = sha256_bytes(pk21_bytes)

    pk21_ok = (
        len(pk21_bytes) == nx_boot1["stage2Size"]
        and actual_pk21_sha == nx_boot1["stage2Sha256"]
        and actual_pk21_sha == kb["pkg2Sha256"]
        and pk21["kernelEntryInt"] == nx_boot1["stage2LoadAddrInt"]
        and stg2["kipCount"] == pk21["kipCount"]
        and stg2["pkg2Size"] == len(pk21_bytes)
        and stg2["pkg2Sha256"] == actual_pk21_sha
    )
    record(
        "BOOT1 Stage 2 Chain",
        pk21_ok,
        f"PK21 {pk21['osVersion']} ({len(pk21_bytes)}B) · NX_BOOT1={actual_pk21_sha == nx_boot1['stage2Sha256']} · KB00={actual_pk21_sha == kb['pkg2Sha256']} · STG2={stg2['pkg2Sha256'] == actual_pk21_sha}",
    )

    # 5. PRODINFOF
    prodf = nxfs_map["PRODINFOF"]
    fca = decode_fca0(prodf["/factory/rail_cal.bin"])
    bat = decode_bat0(prodf["/factory/battery_profile.bin"])
    record(
        "PRODINFOF Factory",
        bool(fca and bat),
        f"FCA0={fca['railModel']} · BAT0={bat['batteryModel']} ({bat['capacityMah']}mAh)",
    )

    # 6. BCPKG2 (KIP1 Manifest SHA-256 verification)
    bcpkg2 = nxfs_map["BCPKG2"]
    kip_ok = True
    loaded_kips = []
    for entry in pk21["manifest"]:
        kpath = f"/kip1/{entry['name']}"
        kbytes = bcpkg2.get(kpath)
        if not kbytes or len(kbytes) != entry["size"] or sha256_bytes(kbytes) != entry["sha256"]:
            kip_ok = False
        else:
            decode_kip1(kbytes, entry["name"])
            loaded_kips.append(entry["name"])
    record(
        "BCPKG2 KIP1 Manifest",
        kip_ok and len(loaded_kips) == 7,
        f"{len(loaded_kips)}/7 KIP1 modules match PK21 size & SHA-256",
    )

    # 7. SAFE
    safe = nxfs_map["SAFE"]
    s_rec = decode_safe(safe["/safe/recovery.bin"])
    r_ui = decode_rfui(safe["/safe/recovery_ui.bin"])
    record(
        "SAFE Recovery",
        bool(s_rec and r_ui),
        f"{s_rec['mode']} · {len(r_ui['options'])} recovery menu entries",
    )

    # 8. SYSTEM
    sysf = nxfs_map["SYSTEM"]
    hosm = decode_hosm(sysf["/sys/os_manifest.bin"])
    qapp = decode_qapp(sysf["/sys/applets/qlaunch.bin"])
    str0 = decode_str0(sysf["/sys/locale/strings.bin"])
    cap0 = decode_cap0(sysf["/sys/caps/capabilities.bin"])
    decode_thm0(sysf["/sys/themes/basic_white.bin"])
    decode_thm0(sysf["/sys/themes/basic_black.bin"])
    verify_trailing_crc32(sysf["/sys/sound/ui_sfx_table.bin"], "SYSTEM SFX0")
    verify_trailing_crc32(sysf["/sys/news/bulletin.bin"], "SYSTEM NWS0")
    verify_trailing_crc32(sysf["/sys/eshop/catalog.bin"], "SYSTEM ESH0")
    art0 = decode_art0(sysf["/sys/assets/artwork_pack.bin"])
    gly0 = decode_gly0(sysf["/sys/assets/avatar_glyphs.bin"])
    spl0 = decode_spl0(sysf["/sys/assets/boot_splash.bin"])
    spr0 = decode_spr0(sysf["/sys/assets/ui_sprites.bin"])
    seq0 = decode_seq0(sysf["/sys/sound/boot_chime.bin"])
    nro0 = decode_nro0(sysf["/sys/code/qlaunch.nro"])
    stlr = decode_stlr(sysf["/sys/code/stellar_data.bin"])
    tet0 = decode_tet0(sysf["/sys/code/tetromino_data.bin"])
    chr0 = decode_chr0(sysf["/sys/code/chromatic_data.bin"])
    eshop_quz0 = decode_quz0(sysf["/sys/eshop/title-trivia.pkg"], "SYSTEM QUZ0")

    home_cap_ok = any(c["titleId"] == hosm["homeAppletId"] for c in cap0)
    sys_ok = (
        hosm["osVersion"] == pk21["osVersion"]
        and hosm["kernelEntryInt"] == pk21["kernelEntryInt"]
        and qapp["titleId"] == hosm["homeAppletId"]
        and nro0["titleId"] == hosm["homeAppletId"]
        and home_cap_ok
        and len(str0) > 0
        and len(art0) >= 6
        and len(spr0) >= 3
        and len(seq0) >= 4
        and len(eshop_quz0["questions"]) > 0
    )
    record(
        "SYSTEM Alignment & Code",
        sys_ok,
        f"HOSM={hosm['osVersion']} · NRO0={nro0['name']} ({nro0['textSize']}B) · ART0={len(art0)} · SPR0={len(spr0)} · GLY0={len(gly0)} · SPL0={spl0['caption']} · STLR/TET0/CHR0 ok",
    )

    # 9. USER
    usr = nxfs_map["USER"]
    settings = decode_set0(usr["/user/save/settings.bin"])
    profiles = decode_prf0(usr["/user/save/profiles.bin"])
    titles = decode_tit0(usr["/user/titles/registry.bin"])
    verify_trailing_crc32(usr["/user/album/captures.bin"], "USER ALB0")

    nxvm_res = decode_and_exec_nxvm(
        sysf["/sys/code/battery_policy.nxb"],
        {
            0: bat["capacityMah"],
            1: bat["factoryCycles"],
            2: bat["internalResistanceMohm"],
            3: settings["brightness"],
            4: 1 if settings["airplaneMode"] else 0,
            5: 1 if settings["dockedMode"] else 0,
            6: cal["fuseCount"],
        },
    )
    record(
        "NXVM Bytecode Policy",
        nxvm_res["instructionsExecuted"] > 0 and 15 <= nxvm_res["batteryPercent"] <= 100,
        f"{nxvm_res['module']}.nxb ({nxvm_res['instructionsExecuted']} ops) -> {nxvm_res['batteryPercent']}% ({nxvm_res['estimatedMinutesLeft']}m, {nxvm_res['healthPercent']}% health)",
    )

    active_ok = any(pr["id"] == settings["activeUserId"] for pr in profiles)
    saves_ok = True
    synced = 0
    for t in titles:
        sbytes = usr.get(t["saveFilePath"])
        if not sbytes:
            saves_ok = False
            continue
        sv = decode_save(sbytes)
        score_ok = (
            (sv["hasHighScore"] and sv["highScore"] == t["highScore"])
            if t["highScore"] is not None
            else (not sv["hasHighScore"] and sv["highScore"] == 0)
        )
        if not sv["valid"] or sv["titleId"] != t["id"] or sv["playMinutes"] != t["playMinutes"] or not score_ok:
            saves_ok = False
        else:
            synced += 1

    trivia_installed = any(t["id"] == "title-trivia" for t in titles)
    trivia_pkg_ok = True
    if trivia_installed:
        pkg_bytes = usr.get("/user/apps/title-trivia.pkg")
        trivia_pkg_ok = bool(pkg_bytes and decode_quz0(pkg_bytes, "USER QUZ0")["questions"])

    record(
        "USER Consistency",
        active_ok and saves_ok and trivia_pkg_ok,
        f"activeUser={settings['activeUserId']} ({active_ok}) · {synced}/{len(titles)} saves synced · eShop pkg={trivia_pkg_ok} · STLR+{stlr['pointsPerRock']} · TET0={len(tet0['shapes'])} shapes · CHR0={len(chr0)} pads",
    )

    return results


def resync_boot_chain(dump: NandDump) -> None:
    """Recompute SHA-256 + CRC32 chain across BOOT0 <-> PRODINFO <-> BOOT1 <-> BCPKG2."""
    b0_part = dump.get_partition("BOOT0")
    b1_part = dump.get_partition("BOOT1")
    pi_part = dump.get_partition("PRODINFO")

    b0_files = unpack_nxfs(b0_part.raw_image)
    b1_files = unpack_nxfs(b1_part.raw_image)
    pi_files = unpack_nxfs(pi_part.raw_image)

    cal = decode_cal0(pi_files["/cal/prodinfo.bin"])
    pk21_bytes = b1_files["/pk21/package2.bin"]

    # Update STG2 if needed
    stg2_body = bytearray(verify_trailing_crc32(b1_files["/pk21/stage2.hdr"], "STG2"))
    struct.pack_into("<I", stg2_body, 20, len(pk21_bytes))
    stg2_body[24:56] = sha256_bytes(pk21_bytes)
    b1_files["/pk21/stage2.hdr"] = with_trailing_crc32(bytes(stg2_body))
    b1_part.raw_image = pack_nxfs(b1_files)

    # Update NX_BOOT1 Stage 2 size & digest
    boot1_body = bytearray(verify_trailing_crc32(b0_files["/boot/nx_boot1.bin"], "NX_BOOT1"))
    struct.pack_into("<I", boot1_body, 0x4C, len(pk21_bytes))
    boot1_body[0x50:0x70] = sha256_bytes(pk21_bytes)
    nx_boot1_bytes = with_trailing_crc32(bytes(boot1_body))
    b0_files["/boot/nx_boot1.bin"] = nx_boot1_bytes

    # Update STG1
    stg1_body = bytearray(verify_trailing_crc32(b0_files["/boot/stage1.hdr"], "STG1"))
    struct.pack_into("<I", stg1_body, 28, len(nx_boot1_bytes))
    stg1_body[32:64] = sha256_bytes(nx_boot1_bytes)
    b0_files["/boot/stage1.hdr"] = with_trailing_crc32(bytes(stg1_body))

    # Rebuild KB00 v2 with current CAL0 identity + Stage 1/2 digests
    kb_bytes = build_kb00_v2(cal, nx_boot1_bytes, pk21_bytes)
    pi_files["/cal/cal0_keyblob.bin"] = kb_bytes
    pi_part.raw_image = pack_nxfs(pi_files)

    # Update BCT0 serial hint + SE root HW digest + KB00 SHA-256 + NX_BOOT1 size/SHA-256 + CRC32
    bct = bytearray(b0_files["/boot/bct.bin"])
    struct.pack_into("<I", bct, 0x10, len(nx_boot1_bytes))
    bct[0x20:0x40] = pack_fixed_str(cal["serial"][:31], 32)
    bct[0xE0:0x100] = sha256_bytes(
        f"NX-SE-ROOT:{cal['serial']}:{cal['boardRevision']}:{cal['macAddress']}".encode("utf-8")
    )
    bct[0x100:0x120] = sha256_bytes(kb_bytes)
    bct[0x120:0x140] = sha256_bytes(nx_boot1_bytes)
    struct.pack_into("<I", bct, 1020, calc_crc32(bytes(bct[:1020])))
    b0_files["/boot/bct.bin"] = bytes(bct)
    b0_part.raw_image = pack_nxfs(b0_files)


# ============================================================================
# CLI Commands
# ============================================================================

def cmd_verify(args: argparse.Namespace) -> None:
    dump = parse_nxnd(Path(args.input).read_bytes())
    checks = run_full_verification(dump)
    passed = 0
    for name, ok, detail in checks:
        tag = "PASS" if ok else "FAIL"
        if ok:
            passed += 1
        print(f"[{tag}] {name:<25} {detail}")
    print(f"\nSummary: {passed}/{len(checks)} cryptographic & structural checks passed.")
    if passed != len(checks):
        sys.exit(1)


def cmd_info(args: argparse.Namespace) -> None:
    dump = parse_nxnd(Path(args.input).read_bytes())
    print(f"NXND v{dump.version} · {len(dump.partitions)} partitions · CRC32 OK")
    print(
        f"{'ID':<12} {'ReqBy':<8} {'Enc':<4} {'Size(B)':>9} {'CRC32':>12}  {'NXFS Status'}"
    )
    print("-" * 72)
    for p in dump.partitions:
        try:
            files = unpack_nxfs(p.raw_image)
            nxfs_status = f"NXFS v2 OK ({len(files)} files)"
        except Exception as exc:
            nxfs_status = f"FAULT: {exc}"
        print(
            f"{p.id:<12} {REQUIRED_BY_MAP.get(p.required_by, '?'):<8} "
            f"{'YES' if p.encrypted else 'NO':<4} {len(p.raw_image):>9} "
            f"0x{calc_crc32(p.raw_image):08X}  {nxfs_status}"
        )


def cmd_list(args: argparse.Namespace) -> None:
    dump = parse_nxnd(Path(args.input).read_bytes())
    targets = (
        [dump.get_partition(args.partition)] if args.partition else dump.partitions
    )
    for p in targets:
        print(f"\n[{p.id}] {p.label} ({len(p.raw_image)} bytes)")
        files = unpack_nxfs(p.raw_image)
        for path, data in files.items():
            print(f"  {path:<34} {len(data):>8} B   CRC32 0x{calc_crc32(data):08X}   SHA256 {sha256_hex(data)[:16]}..")


def cmd_inspect(args: argparse.Namespace) -> None:
    dump = parse_nxnd(Path(args.input).read_bytes())

    boot0_files = unpack_nxfs(dump.get_partition("BOOT0").raw_image)
    bct = decode_bct0(boot0_files["/boot/bct.bin"])
    print("=== BOOT0 (BCT0) ===")
    print(f"  version: {bct['bctVersion']} · entryPoint: {bct['entryPoint']} · dramMhz: {bct['dramMhz']}")
    print(f"  serialHint: {bct['serialHint']} · buildTag: {bct['buildTag']}")
    print(f"  boot1Sha256: {bct['boot1Sha256'].hex()[:24]}.. · keyblobSha256: {bct['keyblobSha256'].hex()[:24]}..")

    boot1_stg1 = decode_nx_boot1(boot0_files["/boot/nx_boot1.bin"])
    print("\n=== BOOT0 (NX_BOOT1) ===")
    print(f"  entryPoint: {boot1_stg1['entryPoint']} · target: {boot1_stg1['stage2Partition']}:{boot1_stg1['stage2Path']} · stage2Size: {boot1_stg1['stage2Size']}B")

    prod_files = unpack_nxfs(dump.get_partition("PRODINFO").raw_image)
    cal = decode_cal0(prod_files["/cal/prodinfo.bin"])
    print("\n=== PRODINFO (CAL0) ===")
    for k, v in cal.items():
        print(f"  {k}: {v}")

    kb_bytes = prod_files.get("/cal/cal0_keyblob.bin") or prod_files.get("/cal/keyblob.bin")
    if kb_bytes:
        kb = decode_kb00(kb_bytes)
        print("\n=== PRODINFO Master Keyblob (KB00) ===")
        print(f"  version: {kb['version']} · revisions: {kb['masterKeyRevisions']} · rsa: {kb.get('rsaBits')}b")
        print(f"  pkg1Sha256: {kb['pkg1Sha256'].hex()[:24]}.. · pkg2Sha256: {kb['pkg2Sha256'].hex()[:24]}..")

    for label, vpath, fn in [
        ("PRODINFO Touch Digitizer (TCAL)", "/cal/touch_cal.bin", decode_tcal),
        ("PRODINFO Audio Codec (ACAL)", "/cal/audio_cal.bin", decode_acal),
        ("PRODINFO 6-Axis IMU (ICAL)", "/cal/imu_cal.bin", decode_ical),
    ]:
        if vpath in prod_files:
            print(f"\n=== {label} ===")
            for k, v in fn(prod_files[vpath]).items():
                print(f"  {k}: {v}")

    prodf_files = unpack_nxfs(dump.get_partition("PRODINFOF").raw_image)
    if "/factory/rail_cal.bin" in prodf_files:
        print("\n=== PRODINFOF Rail Calibration (FCA0) ===")
        for k, v in decode_fca0(prodf_files["/factory/rail_cal.bin"]).items():
            print(f"  {k}: {v}")
    if "/factory/battery_profile.bin" in prodf_files:
        print("\n=== PRODINFOF Battery Fuel Gauge (BAT0) ===")
        for k, v in decode_bat0(prodf_files["/factory/battery_profile.bin"]).items():
            print(f"  {k}: {v}")

    boot1_files = unpack_nxfs(dump.get_partition("BOOT1").raw_image)
    pk21 = decode_pk21(boot1_files["/pk21/package2.bin"])
    print("\n=== BOOT1 Package2 (PK21) ===")
    print(f"  osVersion: {pk21['osVersion']} · kernelEntry: {pk21['kernelEntry']} · kips: {pk21['kipCount']}")

    sys_files = unpack_nxfs(dump.get_partition("SYSTEM").raw_image)
    hosm = decode_hosm(sys_files["/sys/os_manifest.bin"])
    print("\n=== SYSTEM OS Manifest (HOSM) ===")
    for k, v in hosm.items():
        if k != "kernelEntryInt":
            print(f"  {k}: {v}")

    for theme_file in ("/sys/themes/basic_white.bin", "/sys/themes/basic_black.bin"):
        if theme_file in sys_files:
            t = decode_thm0(sys_files[theme_file])
            print(f"\n=== SYSTEM Theme ({theme_file}) ===")
            for k, v in t.items():
                print(f"  {k}: {v}")

    if "/sys/code/qlaunch.nro" in sys_files:
        nro = decode_nro0(sys_files["/sys/code/qlaunch.nro"])
        print("\n=== SYSTEM Executable (NRO0 /sys/code/qlaunch.nro) ===")
        print(f"  name: {nro['name']} · titleId: {nro['titleId']} · entry: {nro['entryAddr']} · .text={nro['textSize']}B (CRC {nro['textCrc32']})")
        print(f"  symbols: {', '.join(nro['symbols'])}")

    usr_files = unpack_nxfs(dump.get_partition("USER").raw_image)
    settings = decode_set0(usr_files["/user/save/settings.bin"])

    if "/sys/code/battery_policy.nxb" in sys_files and "/factory/battery_profile.bin" in prodf_files:
        bat_data = decode_bat0(prodf_files["/factory/battery_profile.bin"])
        nxvm_res = decode_and_exec_nxvm(
            sys_files["/sys/code/battery_policy.nxb"],
            {
                0: bat_data["capacityMah"],
                1: bat_data["factoryCycles"],
                2: bat_data["internalResistanceMohm"],
                3: settings["brightness"],
                4: 1 if settings["airplaneMode"] else 0,
                5: 1 if settings["dockedMode"] else 0,
                6: cal["fuseCount"],
            },
        )
        print("\n=== SYSTEM NXVM Bytecode (/sys/code/battery_policy.nxb) ===")
        print(f"  {nxvm_res['module']} ({nxvm_res['codeBytes']}B, {nxvm_res['instructionsExecuted']} ops) -> {nxvm_res['batteryPercent']}% · {nxvm_res['estimatedMinutesLeft']}m left · {nxvm_res['healthPercent']}% health")

    if "/sys/assets/artwork_pack.bin" in sys_files:
        art = decode_art0(sys_files["/sys/assets/artwork_pack.bin"])
        print("\n=== SYSTEM Box-Art SVGs (ART0) ===")
        print("  " + ", ".join(f"{a['id']} ({a['bytes']}B)" for a in art))
    if "/sys/assets/ui_sprites.bin" in sys_files:
        spr = decode_spr0(sys_files["/sys/assets/ui_sprites.bin"])
        print("\n=== SYSTEM RGBA8888 Sprites (SPR0) ===")
        print("  " + ", ".join(f"{s['id']} ({s['width']}x{s['height']}, {s['bytes']}B)" for s in spr))
    if "/sys/sound/boot_chime.bin" in sys_files:
        seq = decode_seq0(sys_files["/sys/sound/boot_chime.bin"])
        print("\n=== SYSTEM Boot Chime Sequence (SEQ0) ===")
        print("  " + ", ".join(f"{n['freqHz']}Hz@{n['startMs']}ms({n['durationMs']}ms)" for n in seq))
    if "/sys/code/stellar_data.bin" in sys_files and "/sys/code/tetromino_data.bin" in sys_files and "/sys/code/chromatic_data.bin" in sys_files:
        stlr = decode_stlr(sys_files["/sys/code/stellar_data.bin"])
        tet0 = decode_tet0(sys_files["/sys/code/tetromino_data.bin"])
        chr0 = decode_chr0(sys_files["/sys/code/chromatic_data.bin"])
        print("\n=== SYSTEM Game Data Binaries (STLR / TET0 / CHR0) ===")
        print(f"  STLR: speed={stlr['shipSpeed']}, bullet={stlr['bulletSpeed']}, pts={stlr['pointsPerRock']}")
        print(f"  TET0: {len(tet0['shapes'])} shapes, drop={tet0['dropIntervalMs']}ms, lineScore={tet0['lineScore']}")
        print(f"  CHR0: {len(chr0)} pads ({', '.join(p['label'] + '@' + str(p['freqHz']) + 'Hz' for p in chr0)})")

    print("\n=== USER Settings (SET0) ===")
    for k, v in settings.items():
        print(f"  {k}: {v}")

    profiles = decode_prf0(usr_files["/user/save/profiles.bin"])
    print("\n=== USER Profiles (PRF0) ===")
    for prof in profiles:
        print(f"  - {prof['id']}: {prof['name']} ({prof['avatarBg']}, glyph={prof['avatarGlyph']}, {prof['friendCode']})")

    titles = decode_tit0(usr_files["/user/titles/registry.bin"])
    print("\n=== USER Titles & Binary Saves (TIT0 + SAVE) ===")
    for t in titles:
        spath = t["saveFilePath"]
        if spath in usr_files:
            sv = decode_save(usr_files[spath])
            hs = f"Score={sv['highScore']}" if sv["hasHighScore"] else "NoScore"
            print(f"  - {t['id']} ({t['title']}) -> {spath} [{hs}, {sv['playMinutes']}m, user={sv['profileId']}]")
        else:
            print(f"  - {t['id']} ({t['title']}) -> {spath} [MISSING]")


def cmd_extract(args: argparse.Namespace) -> None:
    dump = parse_nxnd(Path(args.input).read_bytes())
    out_dir = Path(args.out_dir)
    for p in dump.partitions:
        part_dir = out_dir / p.id
        part_dir.mkdir(parents=True, exist_ok=True)
        (part_dir / "_raw_partition.bin").write_bytes(p.raw_image)
        try:
            files = unpack_nxfs(p.raw_image)
            for vpath, content in files.items():
                target = part_dir / vpath.lstrip("/")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            print(f"Extracted {p.id}: {len(files)} NXFS files")
        except Exception as exc:
            print(f"Extracted {p.id} raw only (NXFS error: {exc})")


def cmd_replace_file(args: argparse.Namespace) -> None:
    dump = parse_nxnd(Path(args.input).read_bytes())
    part = dump.get_partition(args.partition)
    files = unpack_nxfs(part.raw_image)
    files[args.nxfs_path] = Path(args.local_file).read_bytes()
    part.raw_image = pack_nxfs(files)
    if args.sync:
        resync_boot_chain(dump)
    Path(args.output).write_bytes(pack_nxnd(dump))
    print(f"Replaced {args.partition}:{args.nxfs_path} -> wrote {args.output}")


def cmd_set_prodinfo(args: argparse.Namespace) -> None:
    dump = parse_nxnd(Path(args.input).read_bytes())
    part = dump.get_partition("PRODINFO")
    files = unpack_nxfs(part.raw_image)
    cal = decode_cal0(files["/cal/prodinfo.bin"])
    if args.serial:
        cal["serial"] = args.serial
    if args.region:
        cal["region"] = args.region
    if args.sku:
        cal["sku"] = args.sku
    if args.fuses is not None:
        cal["fuseCount"] = args.fuses
        if not args.no_sync and args.fuses > 0:
            cal["masterKeyHash"] = master_key_hash_hex(args.fuses - 1)
    if args.mac:
        cal["macAddress"] = args.mac
    files["/cal/prodinfo.bin"] = encode_cal0(cal)
    part.raw_image = pack_nxfs(files)
    if not args.no_sync:
        resync_boot_chain(dump)
    Path(args.output).write_bytes(pack_nxnd(dump))
    print(
        f"Updated PRODINFO CAL0{' & re-synced BCT0/KB00 digests' if not args.no_sync else ''} -> wrote {args.output}"
    )


def cmd_set_os(args: argparse.Namespace) -> None:
    dump = parse_nxnd(Path(args.input).read_bytes())
    part = dump.get_partition("SYSTEM")
    files = unpack_nxfs(part.raw_image)
    hosm = decode_hosm(files["/sys/os_manifest.bin"])
    if args.version:
        hosm["osVersion"] = args.version
        if not args.no_sync:
            maj, min_v, pat = [int(x) for x in args.version.split(".")[:3]]
            b1_part = dump.get_partition("BOOT1")
            b1_files = unpack_nxfs(b1_part.raw_image)
            pk_body = bytearray(verify_trailing_crc32(b1_files["/pk21/package2.bin"], "PK21"))
            struct.pack_into("<I", pk_body, 8, (maj << 16) | (min_v << 8) | pat)
            b1_files["/pk21/package2.bin"] = with_trailing_crc32(bytes(pk_body))
            b1_part.raw_image = pack_nxfs(b1_files)
            resync_boot_chain(dump)
    if args.codename:
        hosm["codename"] = args.codename
    if args.build_hash:
        hosm["buildHash"] = args.build_hash
    if args.splash_color:
        hosm["splashColor"] = args.splash_color
    files["/sys/os_manifest.bin"] = encode_hosm(hosm)
    part.raw_image = pack_nxfs(files)
    Path(args.output).write_bytes(pack_nxnd(dump))
    print(f"Updated SYSTEM HOSM -> wrote {args.output}")


def cmd_set_theme(args: argparse.Namespace) -> None:
    dump = parse_nxnd(Path(args.input).read_bytes())
    part = dump.get_partition("SYSTEM")
    files = unpack_nxfs(part.raw_image)
    vpath = (
        "/sys/themes/basic_black.bin"
        if args.theme_id == "dark"
        else "/sys/themes/basic_white.bin"
    )
    thm = decode_thm0(files[vpath])
    if args.bg_canvas:
        thm["bgCanvas"] = args.bg_canvas
        thm["bgHeader"] = args.bg_canvas
    if args.bg_tile:
        thm["bgTile"] = args.bg_tile
    if args.text_primary:
        thm["textPrimary"] = args.text_primary
    if args.focus_cyan:
        thm["focusCyan"] = args.focus_cyan
    files[vpath] = encode_thm0(thm)
    part.raw_image = pack_nxfs(files)
    Path(args.output).write_bytes(pack_nxnd(dump))
    print(f"Updated {vpath} -> wrote {args.output}")


def cmd_set_settings(args: argparse.Namespace) -> None:
    dump = parse_nxnd(Path(args.input).read_bytes())
    part = dump.get_partition("USER")
    files = unpack_nxfs(part.raw_image)
    s = decode_set0(files["/user/save/settings.bin"])
    if args.theme:
        s["theme"] = args.theme
    if args.nickname:
        s["nickname"] = args.nickname
    if args.brightness is not None:
        s["brightness"] = max(30, min(100, args.brightness))
    if args.volume is not None:
        s["volume"] = max(0, min(100, args.volume))
    if args.clock_24h is not None:
        s["clock24h"] = args.clock_24h == "true"
    files["/user/save/settings.bin"] = encode_set0(s)
    part.raw_image = pack_nxfs(files)
    Path(args.output).write_bytes(pack_nxnd(dump))
    print(f"Updated USER SET0 -> wrote {args.output}")


def cmd_corrupt(args: argparse.Namespace) -> None:
    dump = parse_nxnd(Path(args.input).read_bytes())
    part = dump.get_partition(args.partition)
    buf = bytearray(part.raw_image)
    end = min(len(buf), args.offset + args.bytes)
    for i in range(args.offset, end):
        buf[i] ^= 0xFF
    part.raw_image = bytes(buf)
    Path(args.output).write_bytes(pack_nxnd(dump))
    print(
        f"Flipped {end - args.offset} bytes in {args.partition} @ offset {args.offset} -> wrote {args.output}"
    )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Verify, inspect, and modify NX-OS NAND .bin dumps."
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    s_ver = sub.add_parser("verify", help="Run full offline cryptographic & structural audit")
    s_ver.add_argument("input")
    s_ver.set_defaults(func=cmd_verify)

    s_info = sub.add_parser("info", help="Verify NXND & inspect all 8 GPT partitions")
    s_info.add_argument("input")
    s_info.set_defaults(func=cmd_info)

    s_list = sub.add_parser("list", help="List files inside partition NXFS images")
    s_list.add_argument("input")
    s_list.add_argument("partition", nargs="?")
    s_list.set_defaults(func=cmd_list)

    s_insp = sub.add_parser("inspect", help="Decode BOOT0/1, PRODINFO/F, SYSTEM & USER structs")
    s_insp.add_argument("input")
    s_insp.set_defaults(func=cmd_inspect)

    s_ext = sub.add_parser("extract", help="Extract all partition files to a folder")
    s_ext.add_argument("input")
    s_ext.add_argument("out_dir")
    s_ext.set_defaults(func=cmd_extract)

    s_rep = sub.add_parser("replace-file", help="Replace a file inside a partition")
    s_rep.add_argument("input")
    s_rep.add_argument("output")
    s_rep.add_argument("partition")
    s_rep.add_argument("nxfs_path")
    s_rep.add_argument("local_file")
    s_rep.add_argument("--sync", action="store_true", help="Re-sync BCT0/KB00/STG1/STG2 digests")
    s_rep.set_defaults(func=cmd_replace_file)

    s_cal = sub.add_parser("set-prodinfo", help="Modify PRODINFO CAL0 fields")
    s_cal.add_argument("input")
    s_cal.add_argument("output")
    s_cal.add_argument("--serial")
    s_cal.add_argument("--region", choices=REGIONS)
    s_cal.add_argument("--sku", choices=SKUS)
    s_cal.add_argument("--fuses", type=int)
    s_cal.add_argument("--mac")
    s_cal.add_argument("--no-sync", action="store_true", help="Leave BCT0/KB00 digests untouched")
    s_cal.set_defaults(func=cmd_set_prodinfo)

    s_os = sub.add_parser("set-os", help="Modify SYSTEM HOSM OS manifest")
    s_os.add_argument("input")
    s_os.add_argument("output")
    s_os.add_argument("--version")
    s_os.add_argument("--codename")
    s_os.add_argument("--build-hash")
    s_os.add_argument("--splash-color")
    s_os.add_argument("--no-sync", action="store_true", help="Do not sync PK21 version/chain")
    s_os.set_defaults(func=cmd_set_os)

    s_thm = sub.add_parser("set-theme", help="Modify SYSTEM THM0 palette colors")
    s_thm.add_argument("input")
    s_thm.add_argument("output")
    s_thm.add_argument("theme_id", choices=["light", "dark"])
    s_thm.add_argument("--bg-canvas")
    s_thm.add_argument("--bg-tile")
    s_thm.add_argument("--text-primary")
    s_thm.add_argument("--focus-cyan")
    s_thm.set_defaults(func=cmd_set_theme)

    s_set = sub.add_parser("set-settings", help="Modify USER SET0 console settings")
    s_set.add_argument("input")
    s_set.add_argument("output")
    s_set.add_argument("--theme", choices=["light", "dark"])
    s_set.add_argument("--nickname")
    s_set.add_argument("--brightness", type=int)
    s_set.add_argument("--volume", type=int)
    s_set.add_argument("--clock-24h", choices=["true", "false"])
    s_set.set_defaults(func=cmd_set_settings)

    s_cor = sub.add_parser("corrupt", help="Flip bytes in a partition to test bricks")
    s_cor.add_argument("input")
    s_cor.add_argument("output")
    s_cor.add_argument("partition")
    s_cor.add_argument("--offset", type=int, default=64)
    s_cor.add_argument("--bytes", type=int, default=16)
    s_cor.set_defaults(func=cmd_corrupt)

    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    try:
        main()
    except Exception as err:
        print(f"Error: {err}", file=sys.stderr)
        sys.exit(1)
