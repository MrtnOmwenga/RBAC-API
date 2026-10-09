import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * docs/architecture.yaml is drawn as a diagram on the portfolio site, where nothing would notice
 * it going stale. So it is checked here, next to the code it describes.
 */
interface Part { id: string; lane: string; name: string; what: string; detail: string; code: string[]; handbook?: string; story?: string }
interface Step { from: string; to: string; title: string; text: string }
interface Architecture {
  title: string; summary: string; repository: string;
  lanes: { id: string; label: string }[];
  parts: Part[];
  connections: { from: string; to: string; label: string }[];
  flows: { id: string; title: string; summary: string; steps: Step[]; proof?: string }[];
}

const root = join(__dirname, '..');
const architecture = parse(readFileSync(join(root, 'docs/architecture.yaml'), 'utf8')) as Architecture;
const ids = new Set(architecture.parts.map((part) => part.id));
const ID = /^[a-z][a-z0-9-]*$/;

test('every part has an id of its own, a known lane, and something to say', () => {
  const lanes = new Set(architecture.lanes.map((lane) => lane.id));
  expect(ids.size).toBe(architecture.parts.length);
  for (const part of architecture.parts) {
    expect(part.id).toMatch(ID);
    expect(lanes.has(part.lane)).toBe(true);
    for (const text of [part.name, part.what, part.detail]) expect(text.trim()).not.toBe('');
    if (part.story !== undefined) expect(part.story).toMatch(/^[a-z][a-z0-9-]*$/);
  }
});

test('every file a part names exists', () => {
  const missing = architecture.parts.flatMap((part) => part.code.filter((path) => !existsSync(join(root, path))).map((path) => `${part.id}: ${path}`));
  expect(missing).toEqual([]);
  for (const part of architecture.parts) expect(part.code.length).toBeGreaterThan(0);
});

test('connections join parts that exist', () => {
  for (const { from, to } of architecture.connections) expect([ids.has(from), ids.has(to)]).toEqual([true, true]);
});

test('every step of a flow travels along a drawn connection', () => {
  const drawn = new Set(architecture.connections.flatMap(({ from, to }) => [`${from} ${to}`, `${to} ${from}`]));
  for (const flow of architecture.flows) {
    expect(flow.id).toMatch(ID);
    expect(flow.steps.length).toBeGreaterThan(1);
    for (const step of flow.steps) expect(drawn.has(`${step.from} ${step.to}`) ? '' : `${flow.id}: ${step.from} to ${step.to}`).toBe('');
  }
});

test('a test file named as proof exists', () => {
  for (const flow of architecture.flows) {
    for (const [path] of (flow.proof ?? '').matchAll(/\b(?:test|src)\/[\w./-]+\.ts\b/g)) expect(existsSync(join(root, path)) ? '' : path).toBe('');
  }
});
