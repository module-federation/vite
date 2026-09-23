// Provided by the host, consumed by the remote with `import: false` from a
// component the remote only reaches through a dynamic import().
export function lazySharedMessage() {
  return "[shared-lazy] provided by host";
}

export default lazySharedMessage;
