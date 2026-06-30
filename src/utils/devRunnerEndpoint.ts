import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { decodeViteId } from './VirtualModule';

export const MAX_RUNNER_BODY_BYTES = 1024 * 1024;
const ALLOWED_RUNNER_INVOKE_NAMES = new Set(['fetchModule', 'getBuiltins']);

function isPathWithinDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isAllowedRunnerInvokeName(name: unknown): name is 'fetchModule' | 'getBuiltins' {
  return typeof name === 'string' && ALLOWED_RUNNER_INVOKE_NAMES.has(name);
}

export function isSafeRunnerModuleId(id: unknown, projectRoot: string): boolean {
  if (typeof id !== 'string' || !id || id.includes('\0')) return false;

  const decoded = decodeViteId(id).replace(/^\0+/, '');
  if (decoded.includes('..')) return false;
  if (decoded.startsWith('virtual:mf') || decoded.includes('virtual:mf:')) return true;
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(decoded) || decoded.startsWith('//')) return false;

  const root = path.resolve(projectRoot);
  const resolved = path.isAbsolute(decoded) ? path.resolve(decoded) : path.resolve(root, decoded);
  return isPathWithinDirectory(resolved, root);
}

export function readBoundedRequestBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes = MAX_RUNNER_BODY_BYTES
): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    const fail = (statusCode: number, message: string) => {
      if (done) return;
      done = true;
      if (!res.writableEnded) {
        res.statusCode = statusCode;
        res.end(message);
      }
      resolve(undefined);
    };

    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(413, 'Payload too large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => fail(400, 'Bad request'));
  });
}
