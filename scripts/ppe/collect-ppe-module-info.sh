#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  collect-ppe-module-info.sh ROOTFS_OR_MODULE_DIR [OUTPUT_DIR]

ROOTFS_OR_MODULE_DIR can be an extracted root filesystem (containing lib/modules)
or a directory containing kernel modules. OUTPUT_DIR defaults to ./ppe-inventory.

The script is read-only. It does not load modules or change the router.
Optional tools: file, sha256sum, modinfo, strings.
USAGE
}

[[ $# -ge 1 && $# -le 2 ]] || { usage >&2; exit 2; }
INPUT="$(cd "$1" && pwd)"
OUT="${2:-./ppe-inventory}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

if [[ -d "$INPUT/lib/modules" ]]; then
  SEARCH_ROOT="$INPUT"
  FIND_ROOT="$INPUT/lib/modules"
else
  SEARCH_ROOT="$INPUT"
  FIND_ROOT="$INPUT"
fi

REPORT="$OUT/module-report.txt"
: > "$REPORT"
{
  echo "RD16 / IPQ5332 PPE module inventory"
  echo "Input: $SEARCH_ROOT"
  echo "Date (UTC): $(date -u +%FT%TZ)"
  echo
  echo "Tools:"
  for tool in file sha256sum modinfo strings; do
    if command -v "$tool" >/dev/null 2>&1; then
      printf '  %s: %s\n' "$tool" "$(command -v "$tool")"
    else
      printf '  %s: not installed\n' "$tool"
    fi
  done
  echo
} >> "$REPORT"

mapfile -d '' MODULES < <(
  find "$FIND_ROOT" -type f \(
    -iname '*ppe*.ko' -o -iname '*ppe*.ko.*' -o
    -iname '*nss*.ko' -o -iname '*nss*.ko.*' -o
    -iname '*ssdk*.ko' -o -iname '*ssdk*.ko.*' -o
    -iname '*edma*.ko' -o -iname '*edma*.ko.*' -o
    -iname '*ecm*.ko' -o -iname '*ecm*.ko.*' -o
    -iname '*qca*.ko' -o -iname '*qca*.ko.*'
  \) -print0 | sort -z
)

if [[ ${#MODULES[@]} -eq 0 ]]; then
  echo "No candidate modules found. Search root: $FIND_ROOT" | tee -a "$REPORT"
  exit 0
fi

for module in "${MODULES[@]}"; do
  {
    echo "================================================================"
    echo "Path: $module"
    if command -v file >/dev/null 2>&1; then
      file "$module" || true
    fi
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$module" || true
    fi
    if command -v modinfo >/dev/null 2>&1; then
      echo "-- modinfo --"
      modinfo "$module" 2>&1 || true
    fi
    if command -v strings >/dev/null 2>&1; then
      echo "-- filtered strings (first 250 matches) --"
      strings -a "$module" 2>/dev/null |
        grep -Ei 'ppe|nss|ssdk|edma|ecm|qca|vermagic|depends|firmware|offload|fast.?path' |
        head -n 250 || true
    fi
    echo
  } >> "$REPORT"
done

{
  echo "Candidate modules: ${#MODULES[@]}"
  echo "Report: $REPORT"
} | tee "$OUT/summary.txt"

echo "Done. Results written to: $OUT"
