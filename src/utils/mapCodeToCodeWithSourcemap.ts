import MagicString from 'magic-string';

export async function mapCodeToCodeWithSourcemap(code?: string | Promise<string>) {
  const resolvedCode = await code;

  if (resolvedCode === undefined) {
    return;
  }

  const s = new MagicString(resolvedCode);

  return {
    code: s.toString(),
    map: s.generateMap({ hires: true }),
  };
}
