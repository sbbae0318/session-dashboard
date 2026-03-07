import { describe, test, expect } from 'bun:test';
import { fuzzyMatch, fuzzyFilter } from '../src/utils/fuzzy-search.js';

describe('fuzzyMatch()', () => {
  test('empty query matches everything', () => {
    expect(fuzzyMatch('', 'hello world')).toBe(true);
    expect(fuzzyMatch('', '')).toBe(true);
    expect(fuzzyMatch('', 'any text here')).toBe(true);
  });

  test('matching characters in order returns true', () => {
    expect(fuzzyMatch('abc', 'aXbXc')).toBe(true);
    expect(fuzzyMatch('hw', 'hello world')).toBe(true);
    expect(fuzzyMatch('auth', 'authentication')).toBe(true);
  });

  test('non-matching characters returns false', () => {
    expect(fuzzyMatch('xyz', 'hello world')).toBe(false);
    expect(fuzzyMatch('abc', 'bca')).toBe(false);
  });

  test('case-insensitive matching', () => {
    expect(fuzzyMatch('ABC', 'abcdef')).toBe(true);
    expect(fuzzyMatch('abc', 'ABCDEF')).toBe(true);
    expect(fuzzyMatch('Auth', 'authentication')).toBe(true);
  });

  test('exact match returns true', () => {
    expect(fuzzyMatch('hello', 'hello')).toBe(true);
  });

  test('query longer than text returns false', () => {
    expect(fuzzyMatch('abcdefgh', 'abc')).toBe(false);
  });

  test('single character match', () => {
    expect(fuzzyMatch('a', 'apple')).toBe(true);
    expect(fuzzyMatch('z', 'apple')).toBe(false);
  });

  test('characters must appear in order', () => {
    // 'ba' should NOT match 'abc' because 'b' comes after 'a' in 'abc'
    // but 'ba' requires 'b' first then 'a' after it
    expect(fuzzyMatch('ba', 'abc')).toBe(false);
    expect(fuzzyMatch('ab', 'abc')).toBe(true);
  });
});

describe('fuzzyFilter()', () => {
  test('empty query returns all items', () => {
    const items = ['apple', 'banana', 'cherry'];
    const result = fuzzyFilter(items, '', item => item);
    expect(result).toEqual(['apple', 'banana', 'cherry']);
  });

  test('filters items by fuzzy match', () => {
    const items = ['authentication', 'authorization', 'database', 'auth-service'];
    const result = fuzzyFilter(items, 'auth', item => item);
    expect(result).toHaveLength(3);
    expect(result).toContain('authentication');
    expect(result).toContain('authorization');
    expect(result).toContain('auth-service');
    expect(result).not.toContain('database');
  });

  test('works with custom accessor function', () => {
    const items = [
      { id: 1, name: 'Fix authentication bug' },
      { id: 2, name: 'Add new feature' },
      { id: 3, name: 'Refactor auth module' },
    ];

    const result = fuzzyFilter(items, 'auth', item => item.name);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
    expect(result[1].id).toBe(3);
  });

  test('returns empty array when nothing matches', () => {
    const items = ['apple', 'banana', 'cherry'];
    const result = fuzzyFilter(items, 'xyz', item => item);
    expect(result).toHaveLength(0);
  });

  test('handles empty items array', () => {
    const result = fuzzyFilter([], 'query', (item: string) => item);
    expect(result).toEqual([]);
  });
});
