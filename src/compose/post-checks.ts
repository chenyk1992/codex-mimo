import type { GitStatusSnapshot } from "../git/diff.js";
import { parseMimoJsonLines } from "./events.js";

const SEMANTIC_FAILURE_PATTERNS = [
  /what would you like me to help/i,
  /what would you like to work on/i,
  /what would you like to accomplish/i,
  /what task or problem/i,
  /what do you need/i,
  /how can i help/i,
  /what are you trying to accomplish/i,
  /please share your task/i,
  /objective is empty/i,
  /task is empty/i,
  /no objective provided/i,
  /no task provided/i,
  /haven't provided a task/i,
  /haven't provided an actual task/i,
  /message got cut off/i,
  /what's the objective/i,
  /what is the objective/i,
  /what would you like me to plan/i,
  /don't see (?:the )?(?:actual )?task description/i,
  /haven't provided (?:an? |the )?(?:actual )?task/i,
  /(?:have not|haven't|did not|didn't) (?:provide|receive|see).*(?:task|objective|description|goal)/i,
  /(?:missing|without|no).*(?:task|objective|description|goal)/i,
  /only (?:wrote|provided).*objective/i,
  /provided only.*objective/i,
  /no (?:task|objective) provided/i,
  /objective.*empty/i,
];

const CHINESE_FAILURE_SNIPPETS = [
  "\u5c1a\u672a\u63d0\u4f9b\u5177\u4f53\u7684\u4efb\u52a1\u63cf\u8ff0",
  "\u60f3\u8981\u6211\u5e2e\u60a8\u89c4\u5212\u4ec0\u4e48",
  "\u6ca1\u6709\u63d0\u4f9b\u5177\u4f53\u7684\u4efb\u52a1\u76ee\u6807",
  "\u60f3\u8981\u5b8c\u6210\u4ec0\u4e48",
];

export function detectSemanticFailure(eventsStdout: string): string | undefined {
  const events = parseMimoJsonLines(eventsStdout);
  const messages = events.filter((event) => event.type === "message" && event.text);
  const earlyMessages = messages.slice(0, 3);

  for (const event of earlyMessages) {
    const text = (event.text ?? "").toLowerCase().trim();
    if (text.length > 500) continue;
    if (text.includes("```")) continue;
    if (/\bfunction\s+\w+\s*\(/.test(text) || /\bconst\s+\w+\s*=/.test(text)) continue;

    if (SEMANTIC_FAILURE_PATTERNS.some((pattern) => pattern.test(text))) {
      return "MiMoCode did not receive or accept the task objective.";
    }

    const isStandaloneQuestion =
      text.length < 150 && text.endsWith("?") && /^(what|how|please)\s/i.test(text);
    if (isStandaloneQuestion) {
      return "MiMoCode did not receive or accept the task objective.";
    }
  }

  return undefined;
}

export function detectDirectSemanticFailure(summary: string | undefined): string | null {
  if (!summary) return null;
  const text = summary.toLowerCase().trim();
  if (text.length > 500) return null;

  const isStandaloneQuestion =
    text.length < 150 && /[?？]$/.test(text) && /^(what|how|please)\s/i.test(text);

  if (
    SEMANTIC_FAILURE_PATTERNS.some((pattern) => pattern.test(text)) ||
    CHINESE_FAILURE_SNIPPETS.some((snippet) => summary.includes(snippet)) ||
    isStandaloneQuestion
  ) {
    return "MiMoCode did not receive or accept the task objective.";
  }

  return null;
}

export function detectReadOnlyViolationFiles(
  writesAllowed: boolean,
  changedFiles: string[],
  gitStatusBefore?: GitStatusSnapshot,
  gitStatusAfter?: GitStatusSnapshot
): string[] {
  if (writesAllowed) return [];
  if (!gitStatusBefore || !gitStatusAfter) return changedFiles;

  const beforeFiles = parseGitStatusFiles(gitStatusBefore.short);
  const afterFiles = parseGitStatusFiles(gitStatusAfter.short);
  return [...afterFiles].filter((file) => !beforeFiles.has(file));
}

export function buildReadOnlyReportDiff(
  diff: { changedFiles: string[]; diffStat: string; diff: string },
  readOnlyViolationFiles: string[]
): { changedFiles: string[]; diffStat: string; diff: string } {
  if (readOnlyViolationFiles.length === 0) {
    return { changedFiles: [], diffStat: "", diff: "" };
  }
  return { ...diff, changedFiles: readOnlyViolationFiles };
}

export function detectNewFilesFromStatus(before: GitStatusSnapshot, after: GitStatusSnapshot): string[] {
  const beforeFiles = parseGitStatusFiles(before.short);
  const afterFiles = parseGitStatusFiles(after.short);
  return [...afterFiles].filter((file) => !beforeFiles.has(file));
}

export function parseGitStatusFiles(status: string): Set<string> {
  return new Set(
    status
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => (line.length > 3 ? line.slice(3).trim() : line.trim()))
      .filter(Boolean)
  );
}
