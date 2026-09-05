import type { Client } from "@libsql/client";

/**
 * libSQL's local :memory: client has one connection. Queue client operations
 * until a transaction settles; otherwise parallel requests fail TRANSACTION_ACTIVE
 * (and a file DB can synchronously block the Node thread waiting for its own writer).
 * The transaction's own statements bypass this queue. Turso uses server-side locking.
 */
export function localClientQueue(client: Client): Client {
  if (client.protocol !== "file") return client;
  let tail: Promise<unknown> = Promise.resolve();
  const queued = new Set(["execute", "batch", "migrate", "executeMultiple", "sync"]);
  return new Proxy(client, {
    get(target, key) {
      if (key === "transaction") return async (...args: Parameters<Client["transaction"]>) => {
        const previous = tail;
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        tail = previous.then(() => held);
        await previous;
        try {
          const tx = await target.transaction(...args);
          return new Proxy(tx, {
            get(transaction, method) {
              const value = Reflect.get(transaction, method, transaction);
              if (method === "commit" || method === "rollback") return async () => {
                try { return await Reflect.apply(value, transaction, []); } finally { release(); }
              };
              if (method === "close") return () => {
                try { return Reflect.apply(value, transaction, []); } finally { release(); }
              };
              return typeof value === "function" ? value.bind(transaction) : value;
            },
          });
        } catch (err) { release(); throw err; }
      };
      const value = Reflect.get(target, key, target);
      if (typeof key === "string" && queued.has(key)) return (...args: unknown[]) => {
        const result = tail.then(() => Reflect.apply(value, target, args));
        tail = result.then(() => undefined, () => undefined);
        return result;
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
