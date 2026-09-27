import fc from 'fast-check';
import { canonicalJson, digestsEqual, sha256 } from './crypto';

test('canonical JSON is independent of key order and drops undefined', () => {
  expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null }, u: undefined })).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
});

test('canonical JSON parses back to the same value', () => {
  fc.assert(fc.property(fc.jsonValue(), (value) => {
    expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
  }));
});

test('canonical JSON of an object is the same whatever order its keys were inserted in', () => {
  fc.assert(fc.property(fc.dictionary(fc.string(), fc.jsonValue(), { minKeys: 2 }), (obj) => {
    const reversed = Object.fromEntries(Object.entries(obj).reverse());
    expect(canonicalJson(reversed)).toBe(canonicalJson(obj));
  }));
});

test('keys sort as strings, integer-like keys included', () => {
  expect(canonicalJson({ b: 1, 10: 2, 9: 3, a: 4 })).toBe('{"10":2,"9":3,"a":4,"b":1}');
});

test('undefined at the top level encodes as null', () => {
  expect(canonicalJson(undefined)).toBe('null');
});

test('digest comparison', () => {
  expect(digestsEqual(sha256('a'), sha256('a'))).toBe(true);
  expect(digestsEqual(sha256('a'), sha256('b'))).toBe(false);
  expect(digestsEqual(sha256('a'), 'abcd')).toBe(false);
});
