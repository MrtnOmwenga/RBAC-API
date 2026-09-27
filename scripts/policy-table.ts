import { readFileSync, writeFileSync } from 'node:fs';
import { ACTIONS, INTEGRATION_ACTIONS, POLICY, ROLES } from '../src/policy/policy';

/*
 * Renders the permission table in the README from POLICY, so the documentation can't drift from
 * the code. `--check` fails (for CI) if the README is out of date.
 */

const LABEL = { org: 'organization', department: 'department', own: 'own' } as const;
const header = ['Action', ...ROLES.map((r) => `\`${r}\``), 'API key'];
const rows = ACTIONS.map((action) => [
  `\`${action}\``,
  ...ROLES.map((role) => { const reach = POLICY[action][role]; return reach ? LABEL[reach] : '·'; }),
  INTEGRATION_ACTIONS.includes(action) ? 'if scoped' : '·',
]);
const table = [header, header.map(() => '---'), ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n');

const START = '<!-- policy-table:start -->';
const END = '<!-- policy-table:end -->';
const readme = readFileSync('README.md', 'utf8');
const updated = readme.replace(new RegExp(`${START}[\\s\\S]*?${END}`), `${START}\n${table}\n${END}`);

if (process.argv.includes('--check')) {
  if (updated !== readme) {
    console.error('README permission table is out of date: run `npm run policy:table`');
    process.exit(1);
  }
} else {
  writeFileSync('README.md', updated);
}
