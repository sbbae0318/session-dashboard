/**
 * Fuzzy match: checks if all characters in query appear in text in order (case-insensitive).
 * Empty query matches everything.
 */
export function fuzzyMatch(query: string, text: string): boolean {
  if (query === '') {
    return true;
  }

  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();

  let textIndex = 0;

  for (let i = 0; i < queryLower.length; i++) {
    const char = queryLower[i];
    const foundIndex = textLower.indexOf(char, textIndex);

    if (foundIndex === -1) {
      return false;
    }

    textIndex = foundIndex + 1;
  }

  return true;
}

/**
 * Filter items where accessor(item) fuzzy-matches query.
 * Returns all items if query is empty.
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  accessor: (item: T) => string
): T[] {
  if (query === '') {
    return items;
  }

  return items.filter(item => fuzzyMatch(query, accessor(item)));
}
