/**
 * Every file operation of the process, its task workers' included, is carried out by one pool of threads, four of
 * them unless told otherwise. A copy alone keeps eight busy (`treeConcurrency`), and whoever opens a folder
 * meanwhile waits for a thread before the disk is even asked. This makes room for every line of tasks working flat
 * out and leaves a line's worth for the requests.
 *
 * Imported before anything else, and importing nothing itself: the pool takes its size the first time it is used.
 */
export const threadPoolSize = 32;

if (!(Number(process.env.UV_THREADPOOL_SIZE) >= threadPoolSize)) process.env.UV_THREADPOOL_SIZE = String(threadPoolSize);
