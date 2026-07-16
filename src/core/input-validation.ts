import { type ZodError } from "zod";

export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}

export function formatZodError(error: ZodError): string {
  const details = error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "value";
    return `${field}: ${issue.message}`;
  });
  return `Invalid input: ${details.join("; ")}`;
}
