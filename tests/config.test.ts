import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGatewayConfig } from '../src/gateway/config.js';
import { loadNodeConfig } from '../src/node/config.js';

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('node config rejects missing or undersized token', () => {
  withEnv({ DEX_REACH_NODE_TOKEN: undefined }, () => assert.throws(() => loadNodeConfig(), /at least 24/));
  withEnv({ DEX_REACH_NODE_TOKEN: 'short' }, () => assert.throws(() => loadNodeConfig(), /at least 24/));
});

test('node config refuses cleartext remote gateways but permits loopback ws and remote wss', () => {
  const token = 'x'.repeat(32);
  withEnv({ DEX_REACH_NODE_TOKEN: token, DEX_REACH_GATEWAY_WS: 'ws://remote.example/node' }, () => {
    assert.throws(() => loadNodeConfig(), /must use wss/);
  });
  withEnv({ DEX_REACH_NODE_TOKEN: token, DEX_REACH_GATEWAY_WS: 'ws://127.0.0.1:8787/node' }, () => {
    assert.equal(loadNodeConfig().gatewayWs, 'ws://127.0.0.1:8787/node');
  });
  withEnv({ DEX_REACH_NODE_TOKEN: token, DEX_REACH_GATEWAY_WS: 'wss://remote.example/node' }, () => {
    assert.equal(loadNodeConfig().gatewayWs, 'wss://remote.example/node');
  });
});

test('gateway public identity requires HTTPS whenever it is non-loopback', () => {
  const common = { DEX_REACH_OWNER_PASSWORD: 'x'.repeat(24), DEX_REACH_GATEWAY_HOST: '127.0.0.1' };
  withEnv({ ...common, DEX_REACH_PUBLIC_BASE_URL: 'http://remote.example' }, () => {
    assert.throws(() => loadGatewayConfig(), /must use https/);
  });
  withEnv({ ...common, DEX_REACH_PUBLIC_BASE_URL: 'http://127.0.0.1:8787' }, () => {
    assert.equal(loadGatewayConfig().publicBaseUrl.protocol, 'http:');
  });
  withEnv({ ...common, DEX_REACH_PUBLIC_BASE_URL: 'https://remote.example' }, () => {
    assert.equal(loadGatewayConfig().publicBaseUrl.protocol, 'https:');
  });
});
