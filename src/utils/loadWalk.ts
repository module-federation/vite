type Walk = typeof import('estree-walker').walk;

let walkPromise: Promise<Walk> | null = null;

export function loadWalk(): Promise<Walk> {
  walkPromise ||= import('estree-walker').then(({ walk }) => walk);
  return walkPromise;
}
