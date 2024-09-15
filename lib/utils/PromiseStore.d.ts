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
export declare class PromiseStore<T> {
    private promiseMap;
    private resolveMap;
    set(id: string, promise: Promise<T>): void;
    get(id: string): Promise<T>;
}
