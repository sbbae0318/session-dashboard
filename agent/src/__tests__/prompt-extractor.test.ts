import { describe, it, expect } from 'vitest';
import { extractUserPrompt, isBackgroundSession } from '../prompt-extractor.js';

describe('extractUserPrompt', () => {
  // 1. [analyze-mode] prefix strip + separator 추출
  it('strips [analyze-mode] prefix and extracts content after separator', () => {
    const input = '[analyze-mode]\n---\nactual prompt';
    expect(extractUserPrompt(input)).toBe('actual prompt');
  });

  // 2. [search-mode] prefix strip + separator 추출
  it('strips [search-mode] prefix and extracts content after separator', () => {
    const input = '[search-mode]\n---\nmy search query';
    expect(extractUserPrompt(input)).toBe('my search query');
  });

  // 3. <system-reminder> → null
  it('returns null for <system-reminder> prefix', () => {
    const input = '<system-reminder>some system text';
    expect(extractUserPrompt(input)).toBeNull();
  });

  // 4. [SYSTEM DIRECTIVE: → null
  it('returns null for [SYSTEM DIRECTIVE: prefix', () => {
    const input = '[SYSTEM DIRECTIVE: something]';
    expect(extractUserPrompt(input)).toBeNull();
  });

  // 5. "Continue if you have next steps" → null
  it('returns null for "Continue if you have next steps"', () => {
    const input = 'Continue if you have next steps';
    expect(extractUserPrompt(input)).toBeNull();
  });

  // 6. 일반 프롬프트 → pass-through
  it('returns plain text as-is (pass-through)', () => {
    const input = '일반 프롬프트';
    expect(extractUserPrompt(input)).toBe('일반 프롬프트');
  });

  // 7. 공백만 → null
  it('returns null for whitespace-only input', () => {
    expect(extractUserPrompt('   ')).toBeNull();
  });

  // 8. <ultrawork-mode> prefix strip
  it('strips <ultrawork-mode> prefix and extracts content after separator', () => {
    const input = '<ultrawork-mode>\n---\ndo the work';
    expect(extractUserPrompt(input)).toBe('do the work');
  });

  // 9. <command-instruction> prefix strip
  it('strips <command-instruction> prefix and extracts content after separator', () => {
    const input = '<command-instruction>\n---\nrun this command';
    expect(extractUserPrompt(input)).toBe('run this command');
  });

  // 10. <session-context> prefix strip
  it('strips <session-context> prefix and extracts content after separator', () => {
    const input = '<session-context>\n---\nuser message here';
    expect(extractUserPrompt(input)).toBe('user message here');
  });

  // 11. [system-directive prefix → null
  it('returns null for [system-directive prefix', () => {
    const input = '[system-directive some content]';
    expect(extractUserPrompt(input)).toBeNull();
  });

  // 12. 빈 문자열 → null
  it('returns null for empty string', () => {
    expect(extractUserPrompt('')).toBeNull();
  });
});

describe('isBackgroundSession', () => {
  // 8. "Background:" prefix → true
  it('returns true for "Background:" prefix', () => {
    expect(isBackgroundSession('Background: explore task')).toBe(true);
  });

  // 9. "Task:" prefix → true
  it('returns true for "Task:" prefix', () => {
    expect(isBackgroundSession('Task: something')).toBe(true);
  });

  // 10. "@" 포함 → true
  it('returns true for title containing "@"', () => {
    expect(isBackgroundSession('user@host session')).toBe(true);
  });

  // 11. 일반 타이틀 → false
  it('returns false for regular title', () => {
    expect(isBackgroundSession('Regular title')).toBe(false);
  });

  // 12. null → false
  it('returns false for null', () => {
    expect(isBackgroundSession(null)).toBe(false);
  });
});
