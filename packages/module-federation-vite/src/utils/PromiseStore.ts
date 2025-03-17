/**
 * example:
 * const store = new PromiseStore<number>();
 * store.get("example").then((result) => {
 *  console.log("Result from example:", result); // 42
 * });
 * setTimeout(() => {
 *  store.set("example", Promise.resolve(42));
 * }, 2000);
 */

export class PromiseStore<T> {
  private promiseMap: Map<string, Promise<T>> = new Map();
  private resolveMap: Map<string, (value: T) => void> = new Map();

  set(id: string, promise: Promise<T>): void {
    if (this.resolveMap.has(id)) {
      promise.then(this.resolveMap.get(id)!);
      this.resolveMap.delete(id);
    }
    this.promiseMap.set(id, promise);
  }
  get(id: string): Promise<T> {
    if (this.promiseMap.has(id)) {
      return this.promiseMap.get(id)!;
    }
    const pendingPromise = new Promise<T>((resolve) => {
      this.resolveMap.set(id, resolve);
    });

    this.promiseMap.set(id, pendingPromise);
    return pendingPromise;
  }
}
