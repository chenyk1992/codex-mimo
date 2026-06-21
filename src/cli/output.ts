export interface OutputOptions {
  json?: boolean;
}

export function printResult(data: unknown, options: OutputOptions = {}): void {
  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(formatHuman(data));
  }
}

export function printError(message: string, options: OutputOptions = {}): void {
  if (options.json) {
    console.error(JSON.stringify({ error: message }));
  } else {
    console.error(`Error: ${message}`);
  }
}

function formatHuman(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if ("summary" in obj) return String(obj.summary);
    if ("ok" in obj) return obj.ok ? "OK" : `Failed: ${obj.error ?? "unknown"}`;
    if ("message" in obj) return String(obj.message);
  }
  return JSON.stringify(data, null, 2);
}
