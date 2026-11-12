// openCypher TCK, one vitest test per scenario and dialect.
//
// By default only scenarios in allow-list.json run, and each must pass.
// With TCK_ALL=1 every scenario runs: allow-listed ones must still pass, others
// may fail or skip, and the scenarios that pass are written to
// tmp/tck-passing.json so that they can be added to the allow-list.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, it } from 'vitest';
import { backends } from './backends.js';
import { loadScenarios } from './features.js';
import { runScenario } from './runner.js';

type AllowList = Record<string, Record<string, string[]>>;

const runAll = process.env['TCK_ALL'] === '1';
const allowList = JSON.parse(
  readFileSync(join(import.meta.dirname, 'allow-list.json'), 'utf8'),
) as AllowList;
const scenarios = loadScenarios();
const knownIds = new Set(scenarios.map((s) => s.id));

for (const backend of backends) {
  const allowed = new Set(Object.values(allowList[backend.name] ?? {}).flat());
  const passing: string[] = [];

  describe(`TCK on ${backend.name}`, () => {
    it('allow-list names only existing scenarios', ({ expect }) => {
      expect([...allowed].filter((id) => !knownIds.has(id))).toEqual([]);
    });

    for (const scenario of scenarios) {
      const required = allowed.has(scenario.id);
      if (!required && !runAll) {
        continue;
      }
      it(scenario.id, async (ctx) => {
        const outcome = await runScenario(scenario, backend);
        if (outcome.status === 'skipped') {
          if (required) {
            throw new Error(`Allow-listed scenario was skipped: ${outcome.reason}`);
          }
          ctx.skip(outcome.reason);
        }
        passing.push(scenario.id);
      });
    }

    afterAll(() => {
      if (runAll) {
        const dir = join(import.meta.dirname, '../../tmp');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, `tck-passing-${backend.name}.json`),
          JSON.stringify(passing.sort(), null, 2) + '\n',
        );
      }
    });
  });
}
