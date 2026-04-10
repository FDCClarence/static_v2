/** Shared event bus */
export class EventEmitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * @param {string} type
   * @param {Function} handler
   */
  on(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
    return this;
  }

  /**
   * @param {string} type
   * @param {Function} handler
   */
  off(type, handler) {
    this._listeners.get(type)?.delete(handler);
    return this;
  }

  /**
   * @param {string} type
   * @param {unknown} [detail]
   */
  emit(type, detail) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(detail);
      } catch (_) {
        /* swallow listener errors */
      }
    }
  }
}

export const gameEvents = new EventEmitter();
