import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

export function normalizeInviteCode(value) {
  return String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
}

export function validInviteCode(value) {
  return CODE_PATTERN.test(normalizeInviteCode(value));
}

export function createInviteCode() {
  return [...crypto.randomBytes(8)].map((byte) => ALPHABET[byte & 31]).join('');
}

export function getInviteCode(dir, configured = process.env.SWB_INVITE_CODE) {
  if (configured != null) {
    const code = normalizeInviteCode(configured);
    if (!validInviteCode(code)) throw new Error('SWB_INVITE_CODE must be 8 letters or digits (excluding I, O, 0, 1)');
    return code;
  }

  const file = path.join(dir, 'invite-code.txt');
  if (fs.existsSync(file)) {
    const code = normalizeInviteCode(fs.readFileSync(file, 'utf8'));
    if (!validInviteCode(code)) throw new Error('Saved invite code is invalid: ' + file);
    return code;
  }

  fs.mkdirSync(dir, { recursive: true });
  const code = createInviteCode();
  fs.writeFileSync(file, code + '\n', { flag: 'wx', mode: 0o600 });
  return code;
}

export function matchesInviteCode(expected, candidate) {
  const code = normalizeInviteCode(candidate);
  if (!validInviteCode(code)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code));
}
