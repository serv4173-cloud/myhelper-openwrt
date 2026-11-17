# IPQ5332 PPE research plan

This branch is a **research scaffold**, not a claim that Qualcomm PPE acceleration is implemented or working.

Target hardware: Xiaomi BE3600 RD16 / Qualcomm IPQ5332. Goals:
- inventory the stock firmware and kernel modules related to PPE, NSS, ECM, EDMA, SSDK and packet offload;
- identify the exact source/binary versions and kernel ABI before attempting integration;
- preserve a reproducible evidence trail before changing DTS, drivers, firewall, CAKE or the myhelper daemon;
- later test CAKE/QoS and hardware offload together only after the data path is understood.

## What is included

- `scripts/ppe/collect-ppe-module-info.sh`: inventory module files and metadata from an extracted root filesystem or module directory.
- `scripts/ppe/scan-ppe-sources.sh`: search a supplied source tree for PPE/offload references.
- `.github/workflows/ppe-static-checks.yml`: shell syntax checks for these research scripts.

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
- [x] Add repeatable module/source inventory scripts.
- [x] Add static shell checks.
- [ ] Run inventory against the actual RD16 dump and kernel source tree.
- [ ] Confirm the PPE implementation and its source/license provenance.
- [ ] Design a minimal experiment with rollback and serial/UART recovery available.
- [ ] Only then propose code changes to runtime networking or kernel integration.

The scripts report evidence; they do not decompile binaries into original source and do not patch or flash the router.
