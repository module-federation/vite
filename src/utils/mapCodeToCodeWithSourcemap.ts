import { createSourceMap } from './codeRewriter';

export async function mapCodeToCodeWithSourcemap(code?: string | Promise<string>) {
  const resolvedCode = await code;

  if (resolvedCode === undefined) {
    return;
  }

  return {
    code: resolvedCode,
    map: createSourceMap(resolvedCode),
  };
}
