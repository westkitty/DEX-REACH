import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createGatewayExpressApp, gatewayAllowedHostnames } from '../src/gateway/http-app.js';

function request(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/probe',
      method: 'GET',
      headers
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode || 0));
    });
    req.on('error', reject);
    req.end();
  });
}

test('gateway hostname allowlist includes the configured public host and loopback only', () => {
  assert.deepEqual(
    gatewayAllowedHostnames(new URL('https://mcp.example.test:8443')),
    ['mcp.example.test', 'localhost', '127.0.0.1', '[::1]']
  );
});

test('public MCP origin is accepted while unrelated host/origin values stay blocked', async () => {
  const app = createGatewayExpressApp('127.0.0.1', new URL('https://mcp.example.test'));
  app.get('/probe', (_req, res) => res.status(204).end());

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    assert.equal(await request(address.port, {
      host: 'mcp.example.test',
      origin: 'https://mcp.example.test'
    }), 204);

    assert.equal(await request(address.port, {
      host: 'mcp.example.test',
      origin: 'https://evil.example.test'
    }), 403);

    assert.equal(await request(address.port, {
      host: 'evil.example.test'
    }), 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
