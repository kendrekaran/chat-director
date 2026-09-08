const OPERATIONAL_PATTERNS: RegExp[] = [
  /\b(pause|resume|stop|start)\s+(generation|session|stream)\b/i,
  /\b(increase|raise|set)\s+(max\s+)?(submissions?|limit|allowance|budget)\b/i,
  /\bignore\s+(all\s+)?(previous\s+)?instructions\b/i,
  /\byou\s+are\s+now\b/i,
];

export function normalizeTerm(term: string): string {
  return term.trim().toLowerCase();
}

export function findBlockedTerm(text: string, terms: string[]): string | null {
  const haystack = text.toLowerCase();
  for (const term of terms) {
    const needle = normalizeTerm(term);
    if (!needle) continue;
    if (haystack.includes(needle)) return term.trim();
  }
  return null;
}

export function looksLikeOperationalInstruction(text: string): boolean {
  return OPERATIONAL_PATTERNS.some((pattern) => pattern.test(text));
}

export function screenChatText(
  text: string,
  terms: string[],
): { flagged: boolean; flaggedTerm: string | null; operationalAttempt: boolean } {
  const flaggedTerm = findBlockedTerm(text, terms);
  return {
    flagged: flaggedTerm !== null,
    flaggedTerm,
    operationalAttempt: looksLikeOperationalInstruction(text),
  };
}
