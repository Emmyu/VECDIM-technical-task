// Tiny publish/subscribe so screens reload when records or the sync state change.
type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitChange(): void {
  listeners.forEach((l) => l());
}
