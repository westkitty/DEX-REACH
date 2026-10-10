import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { NodeAuthStore } from '../src/gateway/node-auth.js';

test('revocation refresh cannot overwrite transport enrollment awaiting persistence', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dex-auth-refresh-race-'));
  try{
    const store=new NodeAuthStore(dir);await store.initialize();await store.enroll('node-a');
    const token=await store.createEnrollmentToken('node-a');
    const {publicKey}=crypto.generateKeyPairSync('ed25519');
    const seam=store as unknown as {persistUnlocked:()=>Promise<void>};
    const original=seam.persistUnlocked.bind(store);
    let entered:()=>void=()=>{};let release:()=>void=()=>{};
    const ready=new Promise<void>(resolve=>{entered=resolve;});
    const gate=new Promise<void>(resolve=>{release=resolve;});
    seam.persistUnlocked=async()=>{entered();await gate;await original();};
    const enrollment=store.consumeEnrollment('node-a',token,publicKey.export({type:'spki',format:'pem'}).toString());
    await ready;
    const refresh=store.isRevoked('node-a');
    await new Promise(resolve=>setTimeout(resolve,50));release();
    await enrollment;assert.equal(await refresh,false);
    assert.equal(store.authMode('node-a'),'migrating');
    const reopened=new NodeAuthStore(dir);await reopened.initialize();
    assert.equal(reopened.authMode('node-a'),'migrating');
    assert.equal(reopened.list()[0]?.transportKey,true);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('node credentials are isolated, rotatable, and revocable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-node-auth-'));
  try {
    const store = new NodeAuthStore(dir);
    await store.initialize();
    const tokenA = await store.enroll('node-a');
    const tokenB = await store.enroll('node-b');
    assert.equal(await store.authenticate('node-a', tokenA), true);
    assert.equal(await store.authenticate('node-b', tokenA), false);
    assert.equal(await store.authenticate('node-b', tokenB), true);
    const rotatedA = await store.rotate('node-a', 60_000);
    assert.equal(await store.authenticate('node-a', rotatedA), true);
    assert.equal(await store.authenticate('node-a', tokenA), true);
    assert.equal(await store.authenticate('node-b', rotatedA), false);
    assert.equal(await store.revoke('node-a'), true);
    assert.equal(await store.authenticate('node-a', rotatedA), false);
    assert.equal(await store.authenticate('node-a', tokenA), false);
    assert.equal(await store.authenticate('node-b', tokenB), true);
    await assert.rejects(store.forget('node-b'), /revoke it first/);
    assert.equal(await store.forget('node-a'), true);
    assert.equal(store.list().map(n => n.nodeId).join(','), 'node-b');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('concurrent credential writers preserve independent nodes and allow clean re-enrollment after forget', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-node-auth-race-'));
  try {
    const a = new NodeAuthStore(dir);
    const b = new NodeAuthStore(dir);
    await Promise.all([a.initialize(), b.initialize()]);
    const [tokenA, tokenB] = await Promise.all([a.enroll('node-a'), b.enroll('node-b')]);
    const verify = new NodeAuthStore(dir);
    await verify.initialize();
    assert.equal(await verify.authenticate('node-a', tokenA), true);
    assert.equal(await verify.authenticate('node-b', tokenB), true);
    await verify.revoke('node-a');
    await verify.forget('node-a');
    const replacement = await verify.enroll('node-a');
    assert.equal(await verify.authenticate('node-a', replacement), true);
    assert.equal(await verify.isRevoked('node-a'), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

import { addRevokedNode, loadRevokedNodes, removeRevokedNode } from '../src/shared/revoked-nodes.js';

test('revocation tombstone mutations are atomic across concurrent processes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-revoked-race-'));
  try {
    await addRevokedNode(dir, 'keep');
    await addRevokedNode(dir, 'remove-me');
    await Promise.all([
      addRevokedNode(dir, 'node-a'),
      addRevokedNode(dir, 'node-b'),
      removeRevokedNode(dir, 'remove-me')
    ]);
    assert.deepEqual([...await loadRevokedNodes(dir)].sort(), ['keep', 'node-a', 'node-b']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
