export class PromiseStore<T> {
  private promiseMap: Map<string, Promise<T>> = new Map();
  private resolveMap: Map<string, (value: T) => void> = new Map();

  // set方法接受一个id和一个promise，并将其存储到promiseMap中。
  set(id: string, promise: Promise<T>): void {
    if (this.resolveMap.has(id)) {
      // 如果有待解决的Promise resolve方法，直接resolve结果。
      promise.then(this.resolveMap.get(id)!);
      this.resolveMap.delete(id);
    }
    this.promiseMap.set(id, promise);
  }

  // get方法接受一个id，如果存在对应的Promise则直接返回，否则创建一个新的Promise，并存储resolve方法。
  get(id: string): Promise<T> {
    if (this.promiseMap.has(id)) {
      return this.promiseMap.get(id)!;
    }

    // 如果在调用get时没有对应的Promise，创建一个新的Promise，并将resolve方法存储。
    const pendingPromise = new Promise<T>((resolve) => {
      this.resolveMap.set(id, resolve);
    });

    this.promiseMap.set(id, pendingPromise);
    return pendingPromise;
  }
}