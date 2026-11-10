/**
 * Single FIFO queue for every state mutation. Jar updates and the matching DNR
 * rule update for one event finish before the next event is processed, which
 * removes interleaving races between concurrent Set-Cookie responses.
 */
let chain: Promise<unknown> = Promise.resolve();

export function serial<T>(fn: () => Promise<T> | T): Promise<T> {
  const p = chain.then(fn);
  chain = p.catch((err: unknown) => console.error('[sessionwoy] task failed', err));
  return p;
}
