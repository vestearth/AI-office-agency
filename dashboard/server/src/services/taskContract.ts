import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import type { OfficeLaunch, TaskLaunchContract } from '../../../shared/types';

// After a Start-button step ends, check what the prompt asked for instead of
// trusting the CLI's exit code: the role output was written during the run,
// status.yaml was synced during the run, and validate-yaml.rb passes now.
// validate-yaml.rb is read-only; enforce-output-contract.rb is not (it records
// validation_failed), so the check never runs it.

export type RunValidator = (taskId: string) => Promise<{ ok: boolean; output: string }>;

export const validateYaml = (officeRoot: string): RunValidator => (taskId) => new Promise((resolve) => {
  execFile('ruby', [path.join(officeRoot, 'validate-yaml.rb'), taskId], { cwd: officeRoot, timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ ok: !err, output: `${stdout}${stderr}`.trim().split('\n').slice(-12).join('\n') });
  });
});

const changedSince = async (file: string, since: string) => {
  try { return (await fs.stat(file)).mtime.getTime() >= Date.parse(since); } catch { return false; }
};

export async function checkTaskContract(launch: OfficeLaunch, runDir: string, validate: RunValidator): Promise<TaskLaunchContract> {
  const role = launch.role ?? '';
  const outputFile = `${role}-output.yaml`;
  const [outputWritten, statusSynced, validation] = await Promise.all([
    changedSince(path.join(runDir, outputFile), launch.startedAt),
    changedSince(path.join(runDir, 'status.yaml'), launch.startedAt),
    validate(launch.key),
  ]);
  return { outputFile, outputWritten, statusSynced, validation, met: outputWritten && statusSynced && validation.ok };
}

/** One check per finished launch: the result cannot change once the run is over (a later edit is another step). */
export class TaskContractCache {
  private results = new Map<string, Promise<TaskLaunchContract>>();
  get(launch: OfficeLaunch, runDir: string, validate: RunValidator): Promise<TaskLaunchContract> {
    let result = this.results.get(launch.id);
    if (!result) {
      result = checkTaskContract(launch, runDir, validate);
      this.results.set(launch.id, result);
      result.catch(() => this.results.delete(launch.id));
    }
    return result;
  }
}
