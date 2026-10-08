/** Byte-bounded LRU. Oversized values are returned by callers but never retained. */
export class ByteCache<T> {
  private items = new Map<string, { value: T; bytes: number }>();
  bytes = 0;
  constructor(
    readonly limit: number,
    private readonly measure: (value: T) => number,
  ) {}
  get(key: string): T | undefined {
    const item = this.items.get(key);
    if (!item) return undefined;
    this.items.delete(key);
    this.items.set(key, item);
    return item.value;
  }
  set(key: string, value: T) {
    const old = this.items.get(key);
    if (old) {
      this.bytes -= old.bytes;
      this.items.delete(key);
    }
    const bytes = this.measure(value) + key.length * 2 + 64;
    if (bytes > this.limit) return;
    while (this.bytes + bytes > this.limit) {
      const first = this.items.keys().next().value!;
      this.bytes -= this.items.get(first)!.bytes;
      this.items.delete(first);
    }
    this.items.set(key, { value, bytes });
    this.bytes += bytes;
  }
  delete(key: string) {
    const item = this.items.get(key);
    if (!item) return;
    this.bytes -= item.bytes;
    this.items.delete(key);
  }
  clear() {
    this.items.clear();
    this.bytes = 0;
  }
  get size() {
    return this.items.size;
  }
}
