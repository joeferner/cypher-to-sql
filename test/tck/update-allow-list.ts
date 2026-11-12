// Adds newly passing TCK scenarios to allow-list.json.
//
//   npm run test:tck:all                 # writes tmp/tck-passing-<dialect>.json
//   npm run tck:allow-list -- tier1      # adds new passes to the "tier1" group
//
// A scenario is added only when it passes on every dialect, because a scenario
// that passes on one dialect and not the other counts as a failure. Groups are
// kept sorted. Nothing is ever removed.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type AllowList = Record<string, Record<string, string[]>>;

const tier = process.argv[2];
if (!tier) {
  console.error('Usage: npm run tck:allow-list -- <group>   (for example tier1)');
  process.exit(1);
}

const root = join(import.meta.dirname, '../..');
const allowListPath = join(import.meta.dirname, 'allow-list.json');
const allowList = JSON.parse(readFileSync(allowListPath, 'utf8')) as AllowList;
const dialects = Object.keys(allowList);

const passing = dialects.map((dialect) => {
  const path = join(root, 'tmp', `tck-passing-${dialect}.json`);
  if (!existsSync(path)) {
    console.error(`Missing ${path}. Run \`npm run test:tck:all\` first.`);
    process.exit(1);
  }
  return new Set(JSON.parse(readFileSync(path, 'utf8')) as string[]);
});
const everywhere = [...passing[0]!].filter((id) => passing.every((set) => set.has(id)));

for (const [i, dialect] of dialects.entries()) {
  const groups = allowList[dialect]!;
  const listed = new Set(Object.values(groups).flat());
  const added = everywhere.filter((id) => !listed.has(id));
  groups[tier] = [...(groups[tier] ?? []), ...added].sort();
  const onlyHere = [...passing[i]!].filter((id) => !listed.has(id) && !everywhere.includes(id));
  process.stdout.write(`${dialect}: added ${added.length} to ${tier}\n`);
  if (onlyHere.length > 0) {
    process.stdout.write(
      `  passing on ${dialect} only (not added):\n    ${onlyHere.join('\n    ')}\n`,
    );
  }
}

writeFileSync(allowListPath, JSON.stringify(allowList, null, 2) + '\n');
