# IPQ5332 PPE research plan

This branch is a **research scaffold**, not a claim that Qualcomm PPE acceleration is implemented or working.

Target hardware: Xiaomi BE3600 RD16 / Qualcomm IPQ5332. Goals:
- inventory the stock firmware and kernel modules related to PPE, NSS, ECM, EDMA, SSDK and packet offload;
- identify the exact source/binary versions and kernel ABI before attempting integration;
- preserve a reproducible evidence trail before changing DTS, drivers, firewall, CAKE or the myhelper daemon;
- later test CAKE/QoS and hardware offload together only after the data path is understood.

## What is included

- `scripts/ppe/extract-stock-firmware.sh`: extract UBI/SquashFS from a local stock firmware dump and collect modules and `/lib/firmware`.
- `scripts/ppe/collect-ppe-module-info.sh`: inventory module files and metadata from an extracted root filesystem or module directory.
- `scripts/ppe/scan-ppe-sources.sh`: search a supplied source tree for PPE/offload references.
- `.github/workflows/ppe-static-checks.yml`: shell syntax and argument checks.

## Run locally

Use Linux or WSL. Install `binwalk`, `file`, `squashfs-tools`, `xz-utils`, `zstd`, and `p7zip` using your distribution's package manager. Then install UBI Reader in a Python virtual environment:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install ubi_reader
```

The scripts are stored as text files, so invoke them with Bash:

```bash
# 1. Extract a local MTD dump. Keep the dump out of Git.
bash scripts/ppe/extract-stock-firmware.sh /path/to/mtd19.bin ./rd16-stock

# 2. Inventory PPE/NSS/SSDK/EDMA/ECM/QCA modules and firmware files.
bash scripts/ppe/collect-ppe-module-info.sh ./rd16-stock/squashfs-root ./ppe-inventory

# 3. Search the kernel/OpenWrt source trees for related code and configuration.
bash scripts/ppe/scan-ppe-sources.sh /path/to/kernel-qcom-6.18.y ./ppe-kernel-scan.txt
bash scripts/ppe/scan-ppe-sources.sh /path/to/openwrt-source ./ppe-openwrt-scan.txt
```

The extractor expects a directly extractable SquashFS image inside the UBI/Binwalk output. If the dump contains UBIFS, vendor-specific compression, or another layout, it will stop with diagnostics; it does not guess offsets or modify the dump. Review `report.txt` and the candidate file types.

The scripts are read-only. They do not upload firmware dumps, load modules, change router settings, flash firmware, or recover original source code from binaries.

## Required evidence before implementation

1. **Exact firmware dump**: record source, partition, byte size and SHA-256. Keep proprietary dumps private; do not commit them to this repository.
2. **Kernel ABI**: kernel release, config, compiler/toolchain, module `vermagic`, exported symbols and symbol versions where available.
3. **Module provenance**: hashes and metadata for `qca-nss-*`, `qca-ssdk`, `qca-edma`, PPE/ECM modules and dependencies.
4. **Source provenance**: exact kernel/OpenWrt commit, vendor patches, DTS, Kconfig and Makefiles.
5. **Data-path map**: WAN/LAN interfaces, bridge, DSA/switch topology, NSS/PPE/ECM hooks, netfilter flowtable, qdisc/CAKE placement.
6. **Baseline tests**: throughput, latency under load, packet loss, CPU load, offload counters and reproducible commands.

## Important compatibility rule

A `.ko` file from a stock vendor kernel is not automatically loadable into another kernel. Matching the filename or CPU architecture is insufficient: kernel release, configuration, symbols, compiler ABI and vendor interfaces can all matter. Do not force-load modules on the router.

## CAKE and hardware offload

CAKE needs to see and schedule the traffic whose latency is being controlled. A hardware fast path that bypasses the qdisc can undermine CAKE's shaping/latency guarantees. The intended design must explicitly decide which traffic is offloaded and which traffic remains on the software qdisc path. Do not enable PPE/NSS/ECM blindly alongside CAKE; measure and verify the actual path and counters.

## Current status

- [x] Create an isolated `ppe` branch.
- [x] Add local firmware extraction and inventory scripts.
- [x] Add static shell checks.
- [ ] Run inventory against the actual RD16 dump and kernel source tree.
- [ ] Confirm the PPE implementation and its source/license provenance.
- [ ] Design a minimal experiment with rollback and serial/UART recovery available.
- [ ] Only then propose code changes to runtime networking or kernel integration.

The scripts report evidence; they do not decompile binaries into original source and do not patch or flash the router.
