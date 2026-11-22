# Intelligence runtime foundation (P0.2–P0.4)

This is a **standalone foundation**, not an integrated model router. The existing
planner, catalogue, `modelPlan.ts` validation, provider selection, permissions and
execution behavior are unchanged. No existing provider calls the new probe,
estimator or admission helper. P0 is not complete: a manifest registry,
provider adapters, compatibility/quality gates, routing, and evaluation remain
future work. E0–E4 are synthetic evaluation cohorts, not model-size promises.

## Contracts and privacy boundary

`services/orchestrator/src/intelligence/contracts.ts` defines the hardware,
model, engine, inference and resource contracts without provider-specific types.
Engines only produce inference output; they do not authorize or execute actions.
`allowRemote` is a budget flag, **not** consent or authorization to send data.

`probeHardware()` returns a local snapshot. It does not send it anywhere, persist
it, or log it. Raw probe errors are not included in the result. Injected providers
must also remain local; sending hardware diagnostics to any hosted service needs
separate authorization. Unknown fields are `null`, and probe/inventory statuses
distinguish a known empty list from an unavailable scan.

The built-in sources are deliberately conservative:

| Fact | Source and limits |
|---|---|
| OS, architecture, CPU model and process-available logical CPUs | Node/OS APIs. A mixed CPU set does not become a fabricated single model. |
| CPU ISA | Intersection of Linux `/proc/cpuinfo` flags; a finite set of Windows `IsProcessorFeaturePresent` flags; Intel macOS `sysctl` flags when available. Windows' subset and missing flags are partial evidence, not an exhaustive compatibility test. |
| Host memory | OS total/free capped by known process constraints and process-available memory. If process availability cannot be measured, availability remains unknown. Snapshots may become stale immediately. |
| Accelerators | Linux PCI sysfs (including AMD VRAM figures when exposed), Windows CIM, macOS system profiler, and NVIDIA's local `nvidia-smi` when present. These sources do not enumerate every possible SoC/NPU/virtual accelerator, so their inventory is partial even if empty. Windows' potentially truncated `AdapterRAM` is not used. GPU names, free memory, driver and topology can remain unknown; human-readable macOS capacities are conservatively rounded down. |
| Backend support | **No backend is asserted by default.** Local engine probes can be injected as explicit, engine-scoped or device-scoped evidence. Even positive evidence is not a model/engine/device compatibility or quality qualification. |

The external probes use fixed local executable paths and arguments, no shell,
with timeouts and a minimal environment that excludes provider credentials and
arbitrary module/search paths. Windows queries a fixed PowerShell/CIM script and a small
`IsProcessorFeaturePresent` wrapper. An NVIDIA device and free VRAM are not
proof of CUDA support, nor do framebuffer figures prove dedicated memory.
Consequently, the default GPU observations often have unknown topology, and
this estimator rejects an accelerator candidate until an appropriate local
source supplies evidenced topology and available memory.

A profile's `complete` confidence requires the selected fields, a complete
inventory, and actual backend evidence covering CPU and each observed device;
it does not mean every possible engine or backend was tested. A partial profile
can still contain useful positive facts. Device IDs are local to the snapshot;
ambiguous duplicate IDs are discarded rather than guessed. Unmatched WMI and
NVIDIA observations may be aliases and are not counted as distinct physical
GPUs; identical product names alone are never used to join them.

## Resource admission contract

`estimateResourceFit()` is a pure, local calculation. It needs a profile, model
manifest, inference budget, an engine-specific memory placement and optional
policy. It reports a **resource-only** `within-budget` or `reject` decision,
reasons and the byte breakdown. Unknown or contradictory critical inputs reject;
a complete host-memory observation is required, and unknown VRAM, topology,
cache layout and runtime overhead are never treated as zero. A remote artifact
cannot be admitted by this local estimator.

- Weights are either an engine-specific upper bound on a full resident copy, or
  total stored parameters × effective bits/8 plus explicit quantization scales,
  metadata and non-quantized tensor overhead. Active MoE parameters are not a
  substitute for total stored weights.
- Conventional full-attention KV uses `2 × layers × KV heads × head dimension ×
  bytes per element × context × concurrent sequences`. It is only selected by an
  explicit conventional, non-quantized layout declaration. MLA, sliding-window,
  quantized KV and other layouts require a manifest/backend-provided per-sequence
  upper bound covering the requested context and its layout metadata.
- Runtime bounds include host and accelerator graph/scratch buffers, tokenizer,
  workspace, allocator fragmentation, any extra weight/KV replicas not already
  counted by placement, and fixed/per-sequence overhead at the requested context.
  Missing bounds are not guessed. Input plus output must fit
  the reserved context, which must fit the model's native context.
- Placement specifies separate host and accelerator fractions for both weights
  and KV. They are conservative upper bounds on **separate allocations**, not
  assumptions that a GPU copy replaces a host copy. Retained/mapped/pinned host
  copies must be included. Partial GPU placement must declare CPU offload and the
  budget must permit it.
- Dedicated accelerator allocations are checked against their own available
  pool; shared/unified allocations also consume the host pool. The total load
  counts each physical allocation once. Explicit duplicated copies count twice.
- By default the host reserves 512 MiB and the accelerator 128 MiB, then retains
  25% of each relevant available pool. Overrides may increase headroom or adjust
  reserves, but cannot set headroom below 20%. `maxLoadBytes` caps the combined
  physical allocation and `maxAcceleratorBytes` separately caps the device.
  Byte calculations use conservative rounding, including at large values.

A `within-budget` result is **not** permission to load: the inputs themselves
must be validated and backed by conservative engine/model measurements, and
artifact trust, exact compatibility, privacy, task quality and authorization
must be checked separately. `loadAfterResourceCheck()` is an optional resource
admission helper which never calls its callback when the estimate rejects; it is
not wired into existing loaders and does not perform those other checks.

Neither the estimate nor helper reserves OS memory or serializes other loads.
Before a future integration uses it, that loader must refresh the profile,
coordinate all concurrent loads and reservations, account for existing resident
models and concurrent requests, handle changing availability/allocation failure,
and run all non-resource gates. A successful synthetic estimate is not a
physical performance qualification or an OOM guarantee.

## Tests

```sh
pnpm --filter @vanessa/orchestrator test:intelligence
```

CI runs provider-neutral lifecycle tests, E0–E4 injected profiles, missing and
contradictory observations, local-probe smoke, backend-evidence tests, CPU and
GPU memory/headroom boundaries, shared/unified pools, partial offload,
nonstandard caches, concurrency, and fail-closed admission. The Windows CI job
also runs the same suite; no physical-device acceptance or model download is
required.
