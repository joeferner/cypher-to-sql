// Messages and hints for syntax errors: ANTLR's message in words a person or an
// LLM can act on, and a hint for common mistakes and for constructs of other
// Cypher versions that the openCypher 9 grammar does not have.

/** Grammar token names in an "expecting" list, as words. */
const TOKEN_WORDS: Record<string, string | null> = {
  SP: null,
  UnescapedSymbolicName: 'a name',
  EscapedSymbolicName: 'a name',
  HexLetter: 'a name',
  StringLiteral: 'a string',
  DecimalInteger: 'a number',
  HexInteger: 'a number',
  OctalInteger: 'a number',
  ExponentDecimalReal: 'a number',
  RegularDecimalReal: 'a number',
};

const MAX_EXPECTED = 10;

/** Keywords that start or shape a clause, for "did you mean". */
const KEYWORDS = [
  'MATCH',
  'OPTIONAL',
  'WHERE',
  'RETURN',
  'WITH',
  'UNWIND',
  'CREATE',
  'MERGE',
  'DELETE',
  'DETACH',
  'REMOVE',
  'FOREACH',
  'ORDER',
  'SKIP',
  'LIMIT',
  'DISTINCT',
  'UNION',
  'CALL',
  'YIELD',
  'CONTAINS',
  'STARTS',
  'ENDS',
  'EXISTS',
  'WHEN',
  'THEN',
  'ELSE',
  'CASE',
  'NULL',
  'TRUE',
  'FALSE',
  'DESC',
  'ASC',
];

/** Constructs outside the grammar, found in the query text, and what to do instead. */
const EXTENSIONS: [RegExp, string][] = [
  [
    /\breduce\s*\(/i,
    'reduce() is not supported. For a sum or a product, UNWIND the list and aggregate (sum(x)); otherwise compute the value in the application.',
  ],
  [
    /\bCALL\s*\{/i,
    'CALL { ... } subqueries are not supported. Rewrite with WITH, OPTIONAL MATCH, or a pattern comprehension such as [(a)-->(b) | b.name].',
  ],
  [
    /\b(COUNT|COLLECT)\s*\{/i,
    'COUNT { ... } and COLLECT { ... } are not supported. Count with size([(a)-->(b) | 1]) and collect with [(a)-->(b) | b]; EXISTS { ... } works.',
  ],
  [
    /^\s*LOAD\s+CSV\b/i,
    'LOAD CSV is not supported. Pass the rows as a list parameter: UNWIND $rows AS row.',
  ],
  [/^\s*USE\b/i, 'USE is not supported: the graph is the one createGraph() was given.'],
  [/:\s*\$\s*\(/, 'Dynamic labels and types ($(...)) are not supported.'],
  [/\bAS\s+['"]/i, 'A name is not a string: quote it with backticks, as in AS `my name`.'],
];

export interface SyntaxErrorText {
  message: string;
  hint: string | undefined;
}

/**
 * The message and hint for ANTLR's syntax error `msg` in `source`, where
 * `offending` is the text of the token at the error (`<EOF>` at the end).
 */
export function describeSyntaxError(
  source: string,
  msg: string,
  offending: string | undefined,
): SyntaxErrorText {
  const atEnd = offending === '<EOF>';
  let message = msg
    .replace(/^(mismatched|extraneous) input '<EOF>'/, 'the query ended too early,')
    .replace(/'<EOF>'/g, 'the end of the query');
  message = message.replace(/ expecting (\{[^}]*\}|\S+)$/, (_, list: string) => {
    const words = [
      ...new Set(
        list
          .replace(/^\{|\}$/g, '')
          .split(', ')
          .map((name) => (name in TOKEN_WORDS ? TOKEN_WORDS[name] : name))
          .filter((word): word is string => word !== null),
      ),
    ];
    if (words.length === 0) {
      return '';
    }
    const shown = words.slice(0, MAX_EXPECTED).join(', ');
    return words.length === 1
      ? ` expecting ${shown}`
      : ` expecting one of ${shown}${words.length > MAX_EXPECTED ? ', ...' : ''}`;
  });
  message = message.replace(/,$/, '');
  const unclosed = /^token recognition error at: '['"`]/.test(msg)
    ? 'A string or a backticked name is not closed: end it with the same quote it starts with.'
    : undefined;
  return {
    message: `Invalid Cypher: ${message}`,
    hint: unclosed ?? hintFor(source, offending, atEnd),
  };
}

function hintFor(
  source: string,
  offending: string | undefined,
  atEnd: boolean,
): string | undefined {
  for (const [pattern, hint] of EXTENSIONS) {
    if (pattern.test(source)) {
      return hint;
    }
  }
  if (offending && /^[A-Za-z]{3,}$/.test(offending)) {
    const word = offending.toUpperCase();
    if (!KEYWORDS.includes(word)) {
      const close = KEYWORDS.find(
        (k) => Math.abs(k.length - word.length) <= 2 && distance(k, word) <= 2,
      );
      if (close) {
        return `Did you mean ${close}?`;
      }
    }
  }
  if (atEnd && !/\bRETURN\b/i.test(source)) {
    return 'A query that does not write ends with RETURN.';
  }
  return undefined;
}

/** Levenshtein distance. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}
