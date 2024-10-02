export const warn = (message: string) =>
  message.split('\n').forEach((msg) => console.warn('\x1b[33m%s\x1b[0m', msg));
