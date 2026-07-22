import fs from "node:fs";
import { extractFinalText, parseMimoJsonLines } from "../compose/events.js";

export function readFinalJobOutput(eventsFile: string): string | undefined {
  try {
    const raw = fs.readFileSync(eventsFile, "utf8");
    const finalText = extractFinalText(parseMimoJsonLines(raw));
    return finalText || undefined;
  } catch {
    return undefined;
  }
}
