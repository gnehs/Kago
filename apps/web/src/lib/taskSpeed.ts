import type { FileTask } from "../types/kago";

/** How far back a speed looks: long enough to be steady, short enough to follow a change. */
const speedWindowMs = 5000;
/** Less than this between two sightings says more about when they arrived than about the task. */
const shortestMs = 1000;

const sightings = new Map<string, Array<{ time: number; bytes: number }>>();

/**
 * Gives each running task its speed, told from how its bytes have grown over the last few times the list was
 * fetched: the server keeps the count, not the pace. A task that has stopped moving comes out at nothing.
 */
export function withSpeeds(tasks: FileTask[], now = Date.now()): FileTask[] {
  const running = new Set<string>();
  const timed = tasks.map((task) => {
    if (task.status !== "running") return task;
    running.add(task.id);
    const samples = sightings.get(task.id) ?? [];
    sightings.set(task.id, samples);
    samples.push({ time: now, bytes: task.processed_bytes });
    while (samples.length > 2 && now - samples[0]!.time > speedWindowMs) samples.shift();
    const first = samples[0]!;
    const elapsed = now - first.time;
    return elapsed >= shortestMs ? { ...task, speed: Math.max(0, Math.round(((task.processed_bytes - first.bytes) / elapsed) * 1000)) } : task;
  });
  for (const id of sightings.keys()) if (!running.has(id)) sightings.delete(id);
  return timed;
}
