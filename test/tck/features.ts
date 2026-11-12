import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AstBuilder, compile, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator, type Pickle } from '@cucumber/messages';

export const FEATURES_DIR = join(import.meta.dirname, '../../vendor/openCypher/tck/features');

export interface TckScenario {
  /**
   * Stable id used by the allow-list: `<feature path>: <scenario name>`, plus
   * ` #<n>` for the n-th example of a scenario outline.
   */
  id: string;
  featurePath: string;
  pickle: Pickle;
}

/** Loads every scenario of every feature file, with scenario outlines expanded. */
export function loadScenarios(): TckScenario[] {
  const newId = IdGenerator.incrementing();
  const parser = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher());
  const scenarios: TckScenario[] = [];

  for (const file of listFeatureFiles(FEATURES_DIR)) {
    const featurePath = relative(FEATURES_DIR, file);
    const document = parser.parse(readFileSync(file, 'utf8'));
    const pickles = compile(document, featurePath, newId);

    const counts = new Map<string, number>();
    for (const pickle of pickles) {
      counts.set(pickle.name, (counts.get(pickle.name) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    for (const pickle of pickles) {
      const n = (seen.get(pickle.name) ?? 0) + 1;
      seen.set(pickle.name, n);
      const suffix = (counts.get(pickle.name) ?? 0) > 1 ? ` #${n}` : '';
      scenarios.push({ id: `${featurePath}: ${pickle.name}${suffix}`, featurePath, pickle });
    }
  }
  return scenarios;
}

function listFeatureFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return listFeatureFiles(path);
      }
      return entry.name.endsWith('.feature') ? [path] : [];
    })
    .sort();
}
