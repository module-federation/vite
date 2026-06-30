import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  isAllowedRunnerInvokeName,
  isSafeRunnerModuleId,
  readBoundedRequestBody,
} from '../devRunnerEndpoint';

function createMockResponse() {
  const res = {
    statusCode: 200,
    ended: false,
    body: undefined as string | undefined,
    end(message?: string) {
      this.ended = true;
      this.body = message;
    },
  };
  return res;
}

function createMockRequest(chunks: Buffer[]) {
  const req = new EventEmitter() as IncomingMessage;
  queueMicrotask(() => {
    for (const chunk of chunks) req.emit('data', chunk);
    req.emit('end');
  });
  return req;
}

describe('devRunnerEndpoint', () => {
  it('allows only supported runner invoke names', () => {
    expect(isAllowedRunnerInvokeName('fetchModule')).toBe(true);
    expect(isAllowedRunnerInvokeName('getBuiltins')).toBe(true);
    expect(isAllowedRunnerInvokeName('eval')).toBe(false);
  });

  it('rejects module ids outside the project root', () => {
    const root = '/workspace/project';
    expect(isSafeRunnerModuleId('/workspace/project/src/App.tsx', root)).toBe(true);
    expect(isSafeRunnerModuleId('react', root)).toBe(true);
    expect(isSafeRunnerModuleId('virtual:mf:remote.js', root)).toBe(true);
    expect(isSafeRunnerModuleId('/etc/passwd', root)).toBe(false);
    expect(isSafeRunnerModuleId('../../../etc/passwd', root)).toBe(false);
    expect(isSafeRunnerModuleId('https://evil.test/mod.js', root)).toBe(false);
    expect(isSafeRunnerModuleId('/tmp/other-project/node_modules/react/index.js', root)).toBe(
      false
    );
    expect(isSafeRunnerModuleId('/workspace/project/node_modules/react/index.js', root)).toBe(true);
  });

  it('rejects oversized runner request bodies', async () => {
    const res = createMockResponse();
    const req = createMockRequest([Buffer.alloc(128)]);
    const body = await readBoundedRequestBody(req, res as any, 64);
    expect(body).toBeUndefined();
    expect(res.statusCode).toBe(413);
  });

  it('reads bounded runner request bodies', async () => {
    const res = createMockResponse();
    const payload = Buffer.from('{"name":"getBuiltins","data":[]}');
    const req = createMockRequest([payload]);
    const body = await readBoundedRequestBody(req, res as any);
    expect(body?.toString('utf8')).toBe(payload.toString('utf8'));
  });
});
