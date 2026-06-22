export const COMPOSE_WORKFLOW_NAMES = [
  "brainstorm",
  "dev",
  "fix",
  "fix-ci",
  "plan",
  "execute-plan",
  "review",
  "parallel",
  "worktree",
  "merge",
  "new-skill"
] as const;

export type ComposeWorkflowName = typeof COMPOSE_WORKFLOW_NAMES[number];

export function composeWorkflowUsage(): string {
  return COMPOSE_WORKFLOW_NAMES.join("|");
}
