type HookLike<TThis, TArgs extends unknown[], TResult> =
  | ((this: TThis, ...args: TArgs) => TResult)
  | { handler: (this: TThis, ...args: TArgs) => TResult };

export function getHookHandler<TThis, TArgs extends unknown[], TResult>(
  hook: HookLike<TThis, TArgs, TResult> | undefined
): ((this: TThis, ...args: TArgs) => TResult) | undefined {
  return typeof hook === 'function' ? hook : hook?.handler;
}

export function callHook<TThis, TArgs extends unknown[], TResult>(
  hook: HookLike<TThis, TArgs, TResult> | undefined,
  thisArg: TThis,
  ...args: TArgs
): TResult | undefined {
  const handler = getHookHandler(hook);
  return handler?.call(thisArg, ...args);
}
