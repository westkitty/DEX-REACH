import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeNegotiation, negotiateProtocol } from '../src/shared/protocol-negotiation.js';
import type { NodeHello } from '../src/shared/protocol.js';
const offer = { protocolVersion: 1, protocolVersionSemantic: '2.0', supportedProtocols: ['2.0','1.0'], capabilities: { durable_tasks: true, task_event_stream: true } } as NodeHello;
test('malformed semantic offers fail closed while omitted historical metadata remains v1', () => {
  for (const change of [{protocolVersion:2}, {supportedProtocols:[]}, {supportedProtocols:'2.0'}, {supportedProtocols:['2.0','2.0']},
    {supportedProtocols:['3.0']}, {protocolVersionSemantic:'1.0'}, {protocolVersionSemantic:'2.1'}, {supportedProtocols:undefined}]) {
    assert.throws(() => negotiateProtocol({...offer,...change} as NodeHello), /INCOMPATIBLE_PROTOCOL_VERSION/);
  }
  assert.deepEqual(negotiateProtocol({protocolVersion:1} as NodeHello), {version:'1.0',capabilities:[]});
});
test('acknowledgements bind to one offered connection admission and cannot widen it', () => {
  for (const ack of [{protocolVersion:'3.0',capabilities:[]}, {protocolVersion:'1.0',capabilities:['durable_tasks']},
    {protocolVersion:'2.0',capabilities:['two_phase_plan']}, {protocolVersion:'2.0',capabilities:['durable_tasks','durable_tasks']},
    {protocolVersion:'2.0',capabilities:'durable_tasks'}]) {
    assert.throws(() => new NodeNegotiation(offer).acknowledge({type:'hello_ack',...ack}), /invalid acknowledgement/);
  }
  const admission = new NodeNegotiation(offer);
  const ack = {type:'hello_ack',protocolVersion:'2.0',capabilities:['durable_tasks']};
  assert.deepEqual(admission.acknowledge(ack), {version:'2.0',capabilities:['durable_tasks']});
  assert.throws(() => admission.acknowledge(ack), /unexpected/);
  admission.close(); assert.throws(() => admission.request(), /closed/);
  const legacy = new NodeNegotiation(offer);
  assert.deepEqual(legacy.request(), {version:'1.0',capabilities:[]});
  assert.throws(() => legacy.acknowledge(ack), /unexpected/);
  assert.deepEqual(new NodeNegotiation(offer).negotiated, {version:'1.0',capabilities:[]});
});
