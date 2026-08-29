/**
 * Per-container resource accounting, read from inside the container.
 *
 * Attribution comes from the PID namespace rather than from matching host
 * PIDs back to containers: `/proc` inside a container lists only that
 * container's own processes, so a `docker exec` reading `/proc/<pid>/fdinfo`
 * there is already scoped to one engine with nothing to correlate.
 *
 * The exec is not a stylistic choice. A container's processes run as root, and
 * `/proc/<pid>/fdinfo` is readable only by the owning UID -- engined is a
 * `systemd --user` unit, so reading the host's `/proc` would silently skip
 * every engine. Measured with all six running: the host-side read saw
 * 13.45 GiB of desktop applications while the kernel's own amdgpu counters
 * reported 85.07 GiB in use. Going through the containers accounted for the
 * missing 71.63 GiB and reconciled with the kernel to within 10 MiB.
 *
 * Parsing is pure and takes strings, same contract as docker.ts -- the shell
 * snippet below is the only thing that needs a container.
 */

const KIB = 1024;
/** `drm-memory-gtt: \t2048 KiB` -- the kernel pads keys, so the key needs trimming. */
const FDINFO_LINE = /^(?<file>[^:]+):(?<key>[^:]+):(?<value>.*)$/;
const AMOUNT = /^(\d+)\s*KiB$/;
const DIGITS = /^\d+$/;

export interface EngineResources {
  /**
   * The container's cgroup memory, in bytes. Null when the cgroup file is
   * unreadable.
   *
   * Not a substitute for `graphics_bytes` and not comparable to it: a loaded
   * model lands in GTT, which the cgroup does not account for. Measured with
   * three GGUFs resident, `engined-local-llama` reported 1.59 GiB here while
   * holding 40.89 GiB of graphics memory -- a consumer showing only this
   * number understates a busy engine by more than an order of magnitude.
   *
   * It also counts reclaimable page cache, so it spikes after a release and
   * settles on its own: comfy read 8.30 GiB loaded, 33.74 GiB in the seconds
   * after `/release`, then 8.18 GiB once reclaim caught up -- of which
   * 6.67 GiB was cached safetensors, not anything the engine needs held. Read
   * it as a live figure, never as "how much RAM this engine requires".
   */
  memory_bytes: number | null;
  /**
   * Graphics memory this container's processes hold, in bytes, or null when
   * the container has no DRM device to account for at all.
   *
   * VRAM **and** GTT, summed. On an APU both come out of the same physical
   * pool -- the BIOS carve-out is what gets called VRAM and GTT is the rest --
   * so neither number alone describes the footprint. Measured on a Strix Halo
   * box, VRAM alone was 292 MiB against 14810 MiB of GTT: reporting it by
   * itself would have shown 2% of what was actually held.
   */
  graphics_bytes: number | null;
}

/**
 * One shell command, because a status read should cost one `docker exec` and
 * not four. First line is the cgroup byte count, second says whether a DRM
 * device is present at all, and the rest is raw fdinfo for the parser below.
 */
export const RESOURCE_PROBE_SH =
  "cat /sys/fs/cgroup/memory.current 2>/dev/null || echo -; " +
  "if [ -d /dev/dri ]; then echo dri; else echo no-dri; fi; " +
  "grep -H -e '^drm-client-id' -e '^drm-memory-vram' -e '^drm-memory-gtt' " +
  "/proc/[0-9]*/fdinfo/* 2>/dev/null || true";

function kib(value: string): number {
  return Number(AMOUNT.exec(value.trim())?.[1] ?? 0);
}

/**
 * Sums per DRM client, never per fd. One client appears once per open fd --
 * 29 of them for a single process on the machine this was measured against --
 * and every copy repeats that client's whole total, so adding fds up reported
 * 59490 MiB where the box actually held 15101 MiB. Taking the largest
 * observation per `drm-client-id` reproduces the real figure.
 */
interface FdEntry {
  client?: string;
  vram: number;
  gtt: number;
}

/** One `FILE:key:value` line folded into the entry for its fd. */
function foldLine(perFile: Map<string, FdEntry>, line: string): void {
  const parts = FDINFO_LINE.exec(line)?.groups;
  const file = parts?.file;
  const value = parts?.value;
  if (parts === undefined || file === undefined || value === undefined) {
    return;
  }
  const entry = perFile.get(file) ?? { vram: 0, gtt: 0 };
  switch (parts.key?.trim()) {
    case "drm-client-id":
      entry.client = value.trim();
      break;
    case "drm-memory-vram":
      entry.vram = kib(value);
      break;
    case "drm-memory-gtt":
      entry.gtt = kib(value);
      break;
    default:
      return;
  }
  perFile.set(file, entry);
}

/**
 * Sums per DRM client, never per fd. One client appears once per open fd and
 * every copy repeats that client's whole total, so adding fds up reported
 * 59490 MiB on a host holding 15101 MiB. Taking the largest observation per
 * `drm-client-id` reproduces the real figure.
 */
export function parseGraphicsBytes(fdinfo: string): number {
  const perFile = new Map<string, FdEntry>();
  for (const line of fdinfo.split("\n")) {
    foldLine(perFile, line);
  }

  const perClient = new Map<string, { vram: number; gtt: number }>();
  for (const [file, entry] of perFile) {
    // An fd with no client id belongs to no client that can be deduplicated
    // against, so it keys on its own path and is counted once.
    const key = entry.client ?? file;
    const held = perClient.get(key);
    perClient.set(key, {
      vram: Math.max(held?.vram ?? 0, entry.vram),
      gtt: Math.max(held?.gtt ?? 0, entry.gtt),
    });
  }

  let total = 0;
  for (const { vram, gtt } of perClient.values()) {
    total += (vram + gtt) * KIB;
  }
  return total;
}

/** Splits `RESOURCE_PROBE_SH`'s output back into the two numbers it carries. */
export function parseResources(stdout: string): EngineResources {
  const [memory = "-", dri = "no-dri", ...rest] = stdout.split("\n");
  return {
    memory_bytes: DIGITS.test(memory.trim()) ? Number(memory.trim()) : null,
    graphics_bytes: dri.trim() === "dri" ? parseGraphicsBytes(rest.join("\n")) : null,
  };
}
