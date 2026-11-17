#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scan-ppe-sources.sh SOURCE_TREE [OUTPUT_FILE]

Recursively searches source/configuration files for PPE, NSS, SSDK, EDMA,
ECM, flow-offload and CAKE references. Does not modify SOURCE_TREE.
Default output: ./ppe-source-scan.txt
USAGE
}

[[ $# -ge 1 && $# -le 2 ]] || { usage >&2; exit 2; }
ROOT="$(cd "$1" && pwd)"
OUTPUT="${2:-./ppe-source-scan.txt}"
mkdir -p "$(dirname "$OUTPUT")"
: > "$OUTPUT"

PATTERN='(ppe|qca[-_]?nss|nss[-_]?dp|ssdk|edma|ecm|fast.?path|flow.?offload|shortcut.?fe|sfe|hnat|cake|sch_cake|nf_flow_table|netfilter.?flow)'

{
  echo "RD16 / IPQ5332 PPE source scan"
  echo "Root: $ROOT"
  echo "Date (UTC): $(date -u +%FT%TZ)"
  echo "Pattern: $PATTERN"
  echo
} >> "$OUTPUT"

# Skip generated/build output and binary files; grep -I ignores binary content.
find "$ROOT" \
  \( -type d \( -name .git -o -name build_dir -o -name staging_dir \
     -o -name bin -o -name .cache -o -name node_modules \) -prune \) -o \
  \( -type f \( -name '*.c' -o -name '*.h' -o -name '*.dts' \
     -o -name '*.dtsi' -o -name '*.mk' -o -name 'Makefile' \
     -o -name 'Kconfig*' -o -name '*.config' -o -name '*.patch' \
     -o -name '*.yaml' -o -name '*.yml' -o -name '*.sh' \
     -o -name '*.md' -o -name '*.txt' \) -print0 \) |
while IFS= read -r -d '' path; do
  grep -nI -E -i "$PATTERN" "$path" 2>/dev/null |
    sed "s#^#$path:#" || true
done >> "$OUTPUT"

echo "Scan complete: $OUTPUT"
echo "Matches: $(grep -c . "$OUTPUT" || true)"
