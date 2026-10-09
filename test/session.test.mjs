import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { electronDecrypt, electronEncrypt, clearCache, loadSession, loadSessionSync } from '../session.mjs';

test('electronDecrypt handles plaintext:v1: values', () => {
  const secret = 'my-secret-token-12345';
  const encoded = 'plaintext:v1:' + Buffer.from(secret).toString('base64');
  const decrypted = electronDecrypt(encoded, Buffer.alloc(32));
  assert.equal(decrypted, secret);
});

test('electronEncrypt and electronDecrypt roundtrip with AES-256-GCM', () => {
  const key = crypto.randomBytes(32);
  const secret = 'cursor-access-token-xyz-987';
  const encrypted = electronEncrypt(secret, key);
  const decrypted = electronDecrypt(encrypted, key);
  assert.equal(decrypted, secret);
});

test('electronDecrypt fails on tampered ciphertext or wrong key', () => {
  const key1 = crypto.randomBytes(32);
  const key2 = crypto.randomBytes(32);
  const secret = 'secret-payload';
  const encrypted = electronEncrypt(secret, key1);

  // Wrong key
  assert.throws(() => electronDecrypt(encrypted, key2));

  // Corrupted ciphertext
  const raw = Buffer.from(encrypted, 'base64');
  raw[16] ^= 1; // flip a bit in ciphertext
  const corrupted = raw.toString('base64');
  assert.throws(() => electronDecrypt(corrupted, key1));
});

test('clearCache clears token and cached state', () => {
  clearCache();
  // Multiple clearCache calls are safe
  clearCache();
});

test('loadSession rejects gracefully when session files are missing', async () => {
  const origRoot = process.env.GROK_BOT_ROOT;
  process.env.GROK_BOT_ROOT = 'C:\\non-existent-grok-bot-root-' + Date.now();
  clearCache();
  try {
    await assert.rejects(async () => {
      await loadSession();
    });
    assert.throws(() => {
      loadSessionSync();
    });
  } finally {
    if (origRoot !== undefined) process.env.GROK_BOT_ROOT = origRoot;
    else delete process.env.GROK_BOT_ROOT;
    clearCache();
  }
});
