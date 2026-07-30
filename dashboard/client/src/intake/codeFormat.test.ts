import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCode, codeFormatError } from './codeFormat';

const VALID = '6c760f4547fa6e601dc5e93dcea6cc48'; // shape only — never a live code

test('normalizeCode trims, strips inner whitespace, lowercases', () => {
  assert.equal(normalizeCode(`  ${VALID.toUpperCase()}  `), VALID);
  assert.equal(normalizeCode('6c760f45 47fa6e60\t1dc5e93dcea6cc48'), VALID);
});

test('a well-formed code passes local validation (server decides validity)', () => {
  assert.equal(codeFormatError(normalizeCode(VALID)), null);
  assert.equal(codeFormatError(normalizeCode(VALID.toUpperCase())), null);
});

test('a pasted Tester ID is called out explicitly', () => {
  const msg = codeFormatError(normalizeCode('TSTR-ca74dfe968f7b945b3'));
  assert.match(String(msg), /Tester ID/);
  assert.match(String(msg), /TSTR-/);
});

test('wrong-length or non-hex input gets the format hint', () => {
  for (const bad of ['ABCD-1234', '6c760f45', `${VALID}00`, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz']) {
    const msg = codeFormatError(normalizeCode(bad));
    assert.match(String(msg), /32 characters/, `expected a format hint for ${bad}`);
  }
});

test('empty input produces no error (the submit button is disabled instead)', () => {
  assert.equal(codeFormatError(normalizeCode('   ')), null);
});
