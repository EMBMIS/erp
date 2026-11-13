/** True when a successful run came back with every row set empty. */
export function returnedNothing(result) {
  if (!result || typeof result !== 'object') return false
  const arrays = Object.values(result).filter(Array.isArray)
  return arrays.length > 0 && arrays.every((a) => a.length === 0)
}

/** Hostname of a URL, for telling someone where their key will be sent. */
export function hostLabel(url) {
  try {
    return new URL(url).hostname
  } catch {
    return 'that server'
  }
}
