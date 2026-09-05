/**
 * Runs `fn` over `items` with at most `n` in flight (a tiny p-limit). Every
 * item settles; the result order matches `items`.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  n: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const limit = Math.max(1, Math.floor(n));
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}
