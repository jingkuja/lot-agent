function positive(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** None of these limit spending: they are segment and queueing points. An owner's cost limit is per task. */
export function assignmentConfig() {
  return {
    /** The platform pays for search, so this counts calls rather than money. Per node, across retries. */
    webSearchesPerNode: positive("ASSIGNMENT_WEB_SEARCH_LIMIT", 10),
    /** One gateway key can take this many streams at once. */
    runningPerUser: positive("ASSIGNMENT_USER_CONCURRENCY", 8),
    workerConcurrency: positive("ASSIGNMENT_WORKER_CONCURRENCY", 12),
  };
}
