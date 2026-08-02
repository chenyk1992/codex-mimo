import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface PromptTransportResult {
  message: string;
  files: string[];
  /**
   * Optional, immutable inputs that must remain byte-for-byte identical while
   * MiMoCode runs.  This is deliberately opt-in: ordinary prompt transport
   * files remain mutable implementation details.
   */
  immutableAttachments?: ImmutablePromptAttachment[];
}

export interface ImmutablePromptAttachment {
  path: string;
  sha256: string;
  /** Git revision supplied as the review base. */
  base?: string;
  /** HEAD observed while the attachment was captured. */
  head?: string;
}

export interface PromptTransportWorkspaceRemapOptions {
  /** Workspace where the prompt and its attachments were originally created. */
  controlRoot: string;
  /** Isolated workspace in which MiMoCode will execute. */
  executionRoot: string;
}

export type ImmutablePromptAttachmentVerification =
  | { ok: true }
  | { ok: false; path: string; expectedSha256: string; actualSha256?: string };

export function createImmutablePromptAttachment(
  file: string,
  metadata: Omit<ImmutablePromptAttachment, "path" | "sha256"> = {}
): ImmutablePromptAttachment {
  return {
    path: file,
    sha256: hashFile(file),
    ...metadata
  };
}

/**
 * Compatibility is intentional: persisted jobs created before immutable
 * review attachments have no metadata and must continue to run normally.
 */
export function verifyImmutablePromptAttachments(
  prompt: Pick<PromptTransportResult, "immutableAttachments">
): ImmutablePromptAttachmentVerification {
  for (const attachment of prompt.immutableAttachments ?? []) {
    try {
      const actualSha256 = hashFile(attachment.path);
      if (actualSha256 !== attachment.sha256) {
        return {
          ok: false,
          path: attachment.path,
          expectedSha256: attachment.sha256,
          actualSha256
        };
      }
    } catch {
      return {
        ok: false,
        path: attachment.path,
        expectedSha256: attachment.sha256
      };
    }
  }
  return { ok: true };
}

const MAX_PROMPT_ATTACHMENTS = 64;

/**
 * Copies a prompt's attachments into an execution workspace before the agent
 * starts.  Prompt construction happens in the control workspace, but an
 * isolated execution must never retain a readable control-workspace path.
 *
 * This returns a new value; the persisted control prompt is intentionally not
 * modified because it remains useful for diagnostics and resume.
 */
export function remapPromptTransportToWorkspace(
  prompt: PromptTransportResult,
  options: PromptTransportWorkspaceRemapOptions
): PromptTransportResult {
  const controlRoot = resolveWorkspaceRoot(options.controlRoot, "controlRoot");
  const executionRoot = resolveWorkspaceRoot(options.executionRoot, "executionRoot");
  const requestedFiles = [...prompt.files];
  const immutableAttachments = prompt.immutableAttachments ?? [];
  const allSources = [...requestedFiles, ...immutableAttachments.map((attachment) => attachment.path)];
  if (allSources.length > MAX_PROMPT_ATTACHMENTS) {
    throw new Error(`Prompt transport has too many attachments (maximum ${MAX_PROMPT_ATTACHMENTS}).`);
  }

  const destinationDir = createSafeInputsDirectory(executionRoot);
  const copied = new Map<string, CopiedAttachment>();
  const caseInsensitiveSources = new Map<string, string>();

  const copySource = (input: string): CopiedAttachment => {
    const source = resolveAttachmentPath(input, controlRoot);
    const key = pathKey(source);
    const existingSource = caseInsensitiveSources.get(key);
    if (existingSource && existingSource !== source) {
      throw new Error(`Prompt attachment paths collide when compared case-insensitively: ${existingSource} and ${source}.`);
    }
    caseInsensitiveSources.set(key, source);
    const existing = copied.get(key);
    if (existing) return existing;

    assertRegularFile(source);
    const index = copied.size.toString().padStart(2, "0");
    const destination = path.join(destinationDir, `${index}-${hashFile(source).slice(0, 16)}-${safeAttachmentName(source)}`);
    if (!isWithin(destinationDir, destination)) {
      throw new Error(`Unsafe prompt attachment destination for ${source}.`);
    }
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    const result = { source, destination };
    copied.set(key, result);
    return result;
  };

  for (const attachment of immutableAttachments) {
    const source = resolveAttachmentPath(attachment.path, controlRoot);
    assertRegularFile(source);
    const actualSha256 = hashFile(source);
    if (actualSha256 !== attachment.sha256) {
      throw new Error(`Immutable prompt attachment changed before execution: ${attachment.path}.`);
    }
  }

  const remappedFiles = requestedFiles.map((file) => copySource(file).destination);
  const remappedImmutableAttachments = immutableAttachments.map((attachment) => {
    const copiedAttachment = copySource(attachment.path);
    const actualSha256 = hashFile(copiedAttachment.destination);
    if (actualSha256 !== attachment.sha256) {
      throw new Error(`Immutable prompt attachment changed while copying: ${attachment.path}.`);
    }
    return { ...attachment, path: copiedAttachment.destination };
  });

  const references = [...copied.values()].flatMap(({ source, destination }) =>
    attachmentReferenceVariants(source, controlRoot).map((reference) => ({
      reference,
      replacement: promptFileReference(executionRoot, destination)
    }))
  );
  const immutableSourceKeys = new Set(immutableAttachments.map((attachment) =>
    pathKey(resolveAttachmentPath(attachment.path, controlRoot))
  ));
  for (const copiedAttachment of copied.values()) {
    if (immutableSourceKeys.has(pathKey(copiedAttachment.source))) continue;
    remapAttachmentReferencesInFile(copiedAttachment.destination, references);
  }
  return {
    message: remapAttachmentReferences(prompt.message, references),
    files: remappedFiles,
    ...(prompt.immutableAttachments ? { immutableAttachments: remappedImmutableAttachments } : {})
  };
}

export function preparePromptTransport(
  message: string,
  options: { cwd: string; forceFile?: boolean; maxInlineLength?: number }
): PromptTransportResult {
  const maxInlineLength = options.maxInlineLength ?? 8_000;
  const shouldUseFile = Boolean(options.forceFile) ||
    message.length > maxInlineLength ||
    hasNonAscii(message) ||
    hasLineBreak(message);
  if (!shouldUseFile) {
    return { message, files: [] };
  }

  const file = writePromptAttachment(message, { cwd: options.cwd, label: "prompt", extension: ".md" });

  return {
    message: `Read the full UTF-8 task from @${promptFileReference(options.cwd, file)} before acting.`,
    files: [file]
  };
}

export function writePromptAttachment(
  content: string,
  options: { cwd: string; label: string; extension: string }
): string {
  const dir = path.join(options.cwd, ".codex-mimo", "inputs");
  const label = options.label.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+|-+$/g, "") || "input";
  const extension = options.extension.startsWith(".") ? options.extension : `.${options.extension}`;
  const unique = crypto.randomBytes(4).toString("hex");
  const file = path.join(
    dir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${unique}-${label}${extension}`
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

function hasNonAscii(value: string): boolean {
  return /[^\u0000-\u007f]/.test(value);
}

function hasLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

function promptFileReference(cwd: string, file: string): string {
  return path.relative(cwd, file).split(path.sep).join("/");
}

function hashFile(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

interface CopiedAttachment {
  source: string;
  destination: string;
}

function resolveWorkspaceRoot(root: string, label: string): string {
  const resolved = path.resolve(root);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`${label} must be an existing directory.`);
  return fs.realpathSync(resolved);
}

function createSafeInputsDirectory(executionRoot: string): string {
  const directory = path.join(executionRoot, ".codex-mimo", "inputs");
  fs.mkdirSync(directory, { recursive: true });
  const resolvedDirectory = fs.realpathSync(directory);
  if (!isWithin(executionRoot, resolvedDirectory)) {
    throw new Error("Execution prompt input directory escapes the execution workspace.");
  }
  return resolvedDirectory;
}

function resolveAttachmentPath(file: string, controlRoot: string): string {
  if (!file || file.includes("\0")) throw new Error("Prompt attachment path is invalid.");
  return path.resolve(path.isAbsolute(file) ? file : path.join(controlRoot, file));
}

function assertRegularFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error(`Prompt attachment must be a regular file: ${file}.`);
}

function safeAttachmentName(file: string): string {
  const sanitized = path.basename(file).replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "attachment";
}

function pathKey(file: string): string {
  return path.resolve(file).toLocaleLowerCase("en-US");
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function attachmentReferenceVariants(source: string, controlRoot: string): string[] {
  const variants = new Set<string>();
  const add = (value: string) => {
    if (!value) return;
    variants.add(value);
    variants.add(value.split(path.sep).join("/"));
    variants.add(value.split(path.sep).join("\\"));
  };
  add(source);
  const relative = path.relative(controlRoot, source);
  if (relative && isWithin(controlRoot, source)) add(relative);
  return [...variants];
}

function remapAttachmentReferences(
  message: string,
  references: Array<{ reference: string; replacement: string }>
): string {
  const unique = new Map<string, string>();
  for (const { reference, replacement } of references) unique.set(reference, replacement);
  const ordered = [...unique.entries()].sort(([left], [right]) => right.length - left.length);
  let remapped = message;
  for (const [reference, replacement] of ordered) {
    const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    remapped = remapped.replace(new RegExp(`@${escaped}(?=$|[\\s,.;:!?)}\\]])`, "g"), `@${replacement}`);
  }
  return remapped;
}

function remapAttachmentReferencesInFile(
  file: string,
  references: Array<{ reference: string; replacement: string }>
): void {
  const content = fs.readFileSync(file, "utf8");
  const remapped = remapAttachmentReferences(content, references);
  if (remapped !== content) fs.writeFileSync(file, remapped, "utf8");
}
