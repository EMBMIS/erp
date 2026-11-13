// Postgres error codes for "this transaction lost a fair fight over a lock,
// not because anything is wrong — try again": 40P01 deadlock_detected,
// 40001 serialization_failure.
const RETRYABLE_PG_CODES = new Set(['40P01', '40001']);

/**
 * Retry a transactional operation a few times if it fails on deadlock/
 * serialization conflict. Real concurrent load against a single hot
 * row (an inventory item, a storage mapping) does hit these — a FOR UPDATE
 * lock on that row means concurrent writers correctly wait on each other
 * instead of corrupting data, but Postgres can still detect a true deadlock
 * cycle across multiple locked resources within one transaction and abort
 * one side rather than let both wait forever. That abort is safe — the whole
 * transaction rolled back, nothing partial was written — but it's not a
 * useful answer to hand back to a caller who did nothing wrong. Retrying a
 * few times turns "some fraction of concurrent requests fail outright" into
 * "concurrent requests serialize and all succeed," which is the actual goal.
 */
async function withDeadlockRetry(fn, { retries = 4, baseDelayMs = 20 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries || !RETRYABLE_PG_CODES.has(error.code)) throw error;
      const delay = baseDelayMs * 2 ** attempt * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

const itemQueues = new Map();

/**
 * In-memory per-item write queue. Serializes concurrent writes targeting the
 * same inventory item ID(s) within the Node.js application process BEFORE
 * opening/holding Postgres transactions.
 *
 * Sorting item IDs lexicographically guarantees deterministic lock ordering
 * across multi-item batch transactions (e.g. transfers between 2 items),
 * preventing deadlocks between concurrent operations that touch the same items.
 */
async function serializeInventoryItemWrite(inventoryItemIds, fn) {
  const ids = Array.isArray(inventoryItemIds) ? inventoryItemIds : [inventoryItemIds];
  const sortedKeys = Array.from(
    new Set(ids.filter(Boolean).map(id => String(id)))
  ).sort();

  if (sortedKeys.length === 0) {
    return await fn();
  }

  const acquireNext = async (index) => {
    if (index >= sortedKeys.length) {
      return await fn();
    }

    const key = sortedKeys[index];
    const prev = itemQueues.get(key) || Promise.resolve();

    let release;
    const current = new Promise((resolve) => { release = resolve; });
    // Catch-all to prevent unhandled rejection warnings on queue promise chain.
    // The map stores the DERIVED chain, not `current`, so cleanup below must
    // compare against `chain` — comparing against `current` never matched and
    // leaked one resolved entry per completed write under sustained load.
    const chain = prev.then(() => current, () => current);
    itemQueues.set(key, chain);

    try {
      await prev;
      return await acquireNext(index + 1);
    } finally {
      release();
      if (itemQueues.get(key) === chain) {
        itemQueues.delete(key);
      }
    }
  };

  return await acquireNext(0);
}

/**
 * Serialize concurrent writers to the same logical resource (an inventory
 * item, keyed by id) before they each take their own row-level FOR UPDATE
 * lock. Supports a single ID or an array of IDs; multiple IDs are sorted to
 * preserve strict lock ordering.
 */
async function lockInventoryItemForWrite(client, inventoryItemIds) {
  const ids = Array.isArray(inventoryItemIds) ? inventoryItemIds : [inventoryItemIds];
  const sortedIds = Array.from(
    new Set(ids.filter(Boolean).map(id => String(id)))
  ).sort();

  for (const id of sortedIds) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('inventory_item:' || $1::text))",
      [id]
    );
  }
}

module.exports = {
  withDeadlockRetry,
  RETRYABLE_PG_CODES,
  lockInventoryItemForWrite,
  serializeInventoryItemWrite,
};
