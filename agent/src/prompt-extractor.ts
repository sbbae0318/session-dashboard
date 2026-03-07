/**
 * prompt-extractor.ts
 *
 * 사용자 프롬프트에서 시스템 주입 prefix를 제거하고 실제 user content를 추출.
 * session-report 플러그인의 extractUserPrompt() 로직을 독립 구현.
 */

// strip만 (prefix 제거 후 실제 user content 추출)
const SYSTEM_INJECTED_PREFIXES = [
  "[analyze-mode]",
  "[search-mode]",
  "<ultrawork-mode>",
  "<session-context>",
];

// 완전 필터 (null 반환)
const SYSTEM_ONLY_PREFIXES = [
  "[SYSTEM DIRECTIVE:",
  "[system-directive",
  "<system-reminder>",
  "Continue if you have next steps",
  "<command-instruction>",
];
/**
 * 시스템 주입 prefix를 제거하고 실제 user content를 추출.
 * 시스템 전용 프롬프트이면 null 반환.
 */
export function extractUserPrompt(text: string): string | null {
  // 1. SYSTEM_ONLY_PREFIXES 매칭 시 null 반환
  if (SYSTEM_ONLY_PREFIXES.some((p) => text.startsWith(p))) {
    return null;
  }

  // 2. SYSTEM_INJECTED_PREFIXES 매칭 시 prefix strip
  let stripped = text;
  for (const prefix of SYSTEM_INJECTED_PREFIXES) {
    if (stripped.startsWith(prefix)) {
      stripped = stripped.slice(prefix.length);
      break; // 첫 번째 prefix만 제거
    }
  }

  // 3. prefix 제거 후 leading whitespace/separator 제거
  stripped = stripped.replace(/^[\s\-]*\n/, "").trim();

  // 4. '\n---\n' separator 이후 실제 user content 추출
  const separatorIdx = stripped.indexOf("\n---\n");
  if (separatorIdx !== -1) {
    stripped = stripped.slice(separatorIdx + 5).trim();
  }

  // 5. 공백만 남으면 null
  return stripped.length > 0 ? stripped : null;
}

/**
 * 세션 타이틀이 백그라운드 세션인지 확인.
 * "Background:", "Task:", "@" 포함 여부 체크.
 */
export function isBackgroundSession(title: string | null): boolean {
  if (title === null) return false;
  return (
    title.startsWith("Background:") ||
    title.startsWith("Task:") ||
    title.includes("@")
  );
}
