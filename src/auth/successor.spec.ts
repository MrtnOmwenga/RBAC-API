import { openSuccessor, sealSuccessor } from './successor';
import { newRefreshToken } from './tokens';

test('the successor opens only with the token it replaced', () => {
  const [used, next, other] = [newRefreshToken().token, newRefreshToken().token, newRefreshToken().token];
  const sealed = sealSuccessor(used, next);
  expect(sealed).not.toContain(next);
  expect(openSuccessor(used, sealed)).toBe(next);
  expect(openSuccessor(other, sealed)).toBeNull();
});

test('a sealed successor that was altered, cut short or is not one at all opens as nothing', () => {
  const [used, next] = [newRefreshToken().token, newRefreshToken().token];
  const sealed = sealSuccessor(used, next);
  const raw = Buffer.from(sealed, 'base64url');
  raw[raw.length - 1]! ^= 1;
  expect(openSuccessor(used, raw.toString('base64url'))).toBeNull();
  expect(openSuccessor(used, sealed.slice(0, 20))).toBeNull();
  expect(openSuccessor(used, '')).toBeNull();
});

test('sealing the same pair twice gives different text', () => {
  const [used, next] = [newRefreshToken().token, newRefreshToken().token];
  expect(sealSuccessor(used, next)).not.toBe(sealSuccessor(used, next));
});
