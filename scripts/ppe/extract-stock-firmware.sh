#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  extract-stock-firmware.sh MTD_DUMP.bin OUTPUT_DIR

Dependencies (Linux/WSL):
  python3, ubi_reader (pip package), binwalk, file, squashfs-tools,
  xz-utils, zstd, p7zip (package names vary by distribution).

Example:
  python3 -m venv .venv
  . .venv/bin/activate
  pip install ubi_reader
  bash scripts/ppe/extract-stock-firmware.sh /path/to/mtd19.bin ./rd16-stock

The input dump is read-only. Extracted firmware may contain proprietary files;
keep the output private unless you have permission to redistribute it.
USAGE
}

[[ $# -eq 2 ]] || { usage >&2; exit 2; }
DUMP="$(realpath "$1")"
OUT="$2"
[[ -s "$DUMP" ]] || { echo "ERROR: dump is missing or empty: $DUMP" >&2; exit 1; }

for tool in file sha256sum binwalk unsquashfs; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "ERROR: required tool not found: $tool" >&2
    exit 1
  }
done
command -v ubireader_extract_images >/dev/null 2>&1 || {
  echo "ERROR: ubi_reader is missing. Install it with: python3 -m pip install ubi_reader" >&2
  exit 1
}

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
UBI="$OUT/ubi-images"
BINWALK="$OUT/binwalk-output"
ROOTFS="$OUT/squashfs-root"
REPORT="$OUT/report.txt"
mkdir -p "$UBI" "$BINWALK"

{
  echo "RD16 stock firmware extraction report"
  echo "Input: $DUMP"
  echo "Bytes: $(wc -c < "$DUMP" | tr -d ' ')"
  echo "SHA256: $(sha256sum "$DUMP" | awk '{print $1}')"
  file "$DUMP"
  echo
} | tee "$REPORT"

echo "=== UBI extraction ===" | tee -a "$REPORT"
if ! ubireader_extract_images -o "$UBI" "$DUMP" 2>&1 | tee -a "$REPORT"; then
  echo "WARNING: UBI extraction failed; continuing with Binwalk." | tee -a "$REPORT"
fi

echo "=== Binwalk extraction ===" | tee -a "$REPORT"
if ! binwalk -eM -C "$BINWALK" "$DUMP" 2>&1 | tee -a "$REPORT"; then
  echo "WARNING: Binwalk returned an error; inspect report and extracted files." | tee -a "$REPORT"
fi

SQUASHFS=""
while IFS= read -r -d '' candidate; do
  description="$(file -b "$candidate" 2>/dev/null || true)"
  if [[ "$description" == *Squashfs* || "$description" == *squashfs* ]]; then
    SQUASHFS="$candidate"
    break
  fi
done < <(find "$UBI" "$BINWALK" -type f -print0 2>/dev/null)

if [[ -z "$SQUASHFS" ]]; then
  while IFS= read -r -d '' candidate; do
    if unsquashfs -s "$candidate" >/dev/null 2>&1; then
      SQUASHFS="$candidate"
      break
    fi
  done < <(find "$UBI" "$BINWALK" -type f \(
    -iname '*rootfs*' -o -iname '*squashfs*' -o -iname '*ubi*' \) -print0 2>/dev/null)
fi

if [[ -z "$SQUASHFS" ]]; then
  echo "ERROR: no directly extractable SquashFS image was found." | tee -a "$REPORT"
  echo "This dump may use UBIFS, a vendor-modified filesystem, a different partition layout, or unsupported compression." | tee -a "$REPORT"
  echo "Candidate files and detected types:" | tee -a "$REPORT"
  find "$UBI" "$BINWALK" -type f -print0 |
    while IFS= read -r -d '' f; do file "$f" 2>/dev/null || true; done |
    tee -a "$REPORT"
  exit 3
fi

echo "SquashFS candidate: $SQUASHFS" | tee -a "$REPORT"
rm -rf "$ROOTFS"
unsquashfs -d "$ROOTFS" "$SQUASHFS" 2>&1 | tee -a "$REPORT"

echo "=== Collecting modules and firmware ===" | tee -a "$REPORT"
MODULE_OUT="$OUT/modules"
FIRMWARE_OUT="$OUT/firmware"
mkdir -p "$MODULE_OUT" "$FIRMWARE_OUT"

while IFS= read -r -d '' module; do
  rel="${module#"$ROOTFS"/}"
  mkdir -p "$MODULE_OUT/$(dirname "$rel")"
  cp -p "$module" "$MODULE_OUT/$rel"
done < <(find "$ROOTFS" -type f \(
  -name '*.ko' -o -name '*.ko.*' \) -print0)

if [[ -d "$ROOTFS/lib/firmware" ]]; then
  cp -a "$ROOTFS/lib/firmware/." "$FIRMWARE_OUT/"
fi

{
  echo
  echo "Kernel module count: $(find "$MODULE_OUT" -type f | wc -l)"
  echo "Firmware file count: $(find "$FIRMWARE_OUT" -type f | wc -l)"
  echo "Root filesystem: $ROOTFS"
  echo "Modules: $MODULE_OUT"
  echo "Firmware: $FIRMWARE_OUT"
} | tee -a "$REPORT"

echo "Extraction complete: $OUT"
