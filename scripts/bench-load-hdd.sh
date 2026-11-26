#!/usr/bin/env bash
# Runs scripts/bench-load.mjs on a simulated hard disk, inside the Colima VM.
#
#   scripts/bench-load-hdd.sh <label>        # result in $BENCH_RESULTS/<label>.json (default: ./bench-results)
#
# The disk is an image file served by scripts/bench-disk.mjs over NBD: one request at a time, a seek for each that
# is not next to the last. The kernel sees a block device, puts an ext4 on it and queues for it as it would for a
# real one. The working tree is copied into a volume and built there on every run.
set -euo pipefail

label="${1:?usage: bench-load-hdd.sh <label>}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
results="${BENCH_RESULTS:-$repo/bench-results}"
image="node:24-bookworm-slim"
mkdir -p "$results"

vm() { colima ssh -- sudo sh -c "$1"; }

# The disk, made once and kept between runs. Filled and emptied at full speed, and slowed down for the measurement.
vm 'touch /var/tmp/kago-bench.img.fast'
if [ "$(vm 'cat /sys/block/nbd0/size 2>/dev/null || echo 0' | tr -d '\r\n')" = 0 ]; then
  vm 'modprobe nbd nbds_max=1; [ -f /var/tmp/kago-bench.img ] || truncate -s 8G /var/tmp/kago-bench.img'
  docker rm -f kago-bench-disk >/dev/null 2>&1 || true
  docker run -d --name kago-bench-disk --network host -v /var/tmp:/img -v "$repo/scripts":/scripts:ro "$image" node /scripts/bench-disk.mjs /img/kago-bench.img 10809 >/dev/null
  docker run --rm --privileged --network host -v /dev:/dev debian:bookworm-slim sh -c 'apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq nbd-client >/dev/null 2>&1 && nbd-client -N bench 127.0.0.1 10809 /dev/nbd0 >/dev/null'
  vm 'mkfs.ext4 -q -F /dev/nbd0 && echo 1 > /sys/block/nbd0/queue/rotational && echo mq-deadline > /sys/block/nbd0/queue/scheduler'
fi
vm 'mkdir -p /mnt/kago-bench && (mountpoint -q /mnt/kago-bench || mount /dev/nbd0 /mnt/kago-bench)'

docker volume create kago-bench-repo >/dev/null
(cd "$repo" && git ls-files -co --exclude-standard | COPYFILE_DISABLE=1 tar --no-xattrs -cf - -T -) |
  docker run --rm -i -v kago-bench-repo:/repo "$image" sh -c 'find /repo -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .pnpm-home -exec rm -rf {} + && tar -xf - -C /repo'
docker run --rm -v kago-bench-repo:/repo -w /repo -e PNPM_HOME=/repo/.pnpm-home -e CI=1 "$image" bash -c '
  set -e
  [ -x "$PNPM_HOME/bin/pnpm" ] || SHELL=/bin/bash npx --yes get-pnpm 12.9.1 >/dev/null
  export PATH="$PNPM_HOME/bin:$PATH"
  pnpm install --frozen-lockfile --filter @kago/server... >/dev/null
  pnpm --filter @kago/server build >/dev/null'

docker run --rm -v kago-bench-repo:/repo -v /mnt/kago-bench:/hdd -w /repo -e BENCH_DATA=/hdd "$image" node scripts/bench-load.mjs prepare
# Mounted afresh: what was just written stays in memory until its journal is checkpointed, whatever caches are dropped.
vm 'umount /mnt/kago-bench && mount /dev/nbd0 /mnt/kago-bench && echo 3 > /proc/sys/vm/drop_caches && rm /var/tmp/kago-bench.img.fast'

docker run --rm -v kago-bench-repo:/repo -v /mnt/kago-bench:/hdd -v "$results":/results -w /repo \
  -e BENCH_DATA=/hdd -e BENCH_BLOCK_STAT=/sys/block/nbd0/stat -e BENCH_LABEL="$label" -e BENCH_OUT="/results/$label.json" \
  ${BENCH_ENV:+--env-file "$BENCH_ENV"} "$image" node scripts/bench-load.mjs run
