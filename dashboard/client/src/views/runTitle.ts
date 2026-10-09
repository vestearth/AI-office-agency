// The server falls back to the task id when a run has no title; rendering that
// next to the id would just print the id twice.
export function distinctTitle(taskId: string, title: string | null | undefined): string | null {
  const trimmed = title?.trim();
  return trimmed && trimmed !== taskId ? trimmed : null;
}
