import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createInviteCode, getInviteCode, matchesInviteCode, normalizeInviteCode,
} from '../server/invite.js';

test('room codes are easy to share and reject guesses', () => {
  const code = createInviteCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(normalizeInviteCode(code.slice(0, 4) + '-' + code.slice(4).toLowerCase()), code);
  assert.equal(matchesInviteCode(code, code.toLowerCase()), true);
  assert.equal(matchesInviteCode(code, 'AAAAAAAA'), code === 'AAAAAAAA');
  assert.equal(matchesInviteCode(code, 'AAAA'), false);
});

test('generated code survives server restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-invite-'));
  try {
    const first = getInviteCode(dir, null);
    assert.equal(getInviteCode(dir, null), first);
    assert.equal(fs.readFileSync(path.join(dir, 'invite-code.txt'), 'utf8').trim(), first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('configured code is validated and leaves the saved code alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-invite-'));
  try {
    assert.equal(getInviteCode(dir, 'ABCD-EFGH'), 'ABCDEFGH');
    assert.equal(fs.existsSync(path.join(dir, 'invite-code.txt')), false);
    assert.throws(() => getInviteCode(dir, 'short'), /must be 8/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
