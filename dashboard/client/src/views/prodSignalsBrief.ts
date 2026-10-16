import type { ProdSignalsResponse, SignalGroup } from '../../../shared/types';

const ICT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Bangkok', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

/** "10-15 10:43" in Bangkok time (the operator's clock and the services' business day). */
export function ictTime(iso: string): string {
  const parts = Object.fromEntries(ICT.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** A date-only completedAt carries no time, so show the date alone. */
export function closedLabel(completedAt: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(completedAt) ? completedAt.slice(5) : `${ictTime(completedAt)} ICT`;
}

/** "10-16 14:57–15:02": one date, two times. */
export function deploySpan(d: { from: string; to: string }): string {
  return `${ictTime(d.from)}–${ictTime(d.to).slice(6)}`;
}

/** True when every failure of the group fell inside a deployment. */
export const allDuringDeploys = (g: SignalGroup) => Boolean(g.deploys && g.deploys.during >= g.failures);

/** "all 6 failures during 2 deployments (slip-system-production 10-16 14:57–15:02, …)", or null. */
export function deployLine(g: SignalGroup): string | null {
  const d = g.deploys;
  if (!d) return null;
  const share = allDuringDeploys(g) ? `all ${g.failures} failure${g.failures === 1 ? '' : 's'}` : `${d.during} of ${g.failures} failures`;
  const spans = d.windows.map((w) => `${w.service} ${deploySpan(w)}`).join(', ');
  return `${share} during ${d.windows.length} deployment${d.windows.length === 1 ? '' : 's'} (${spans} ICT): likely connections cut by the rollout`;
}

export function coverageLine(g: SignalGroup): string {
  if (g.coverage === 'mentioned') {
    return `mentioned by open ${g.mentionedBy.map((r) => `${r.id} (${r.terms.join(', ')})`).join('; ')}`;
  }
  if (g.coverage === 'recurs_after') {
    return `recurs after closed ${g.recursAfter.map((r) => `${r.id}${r.completedAt ? ` (closed ${closedLabel(r.completedAt)})` : ''}`).join('; ')}`;
  }
  if (g.coverage === 'closed_recently') {
    return `owner closed recently: ${g.closedRecently.map((r) => `${r.id}${r.completedAt ? ` (closed ${closedLabel(r.completedAt)})` : ''}`).join('; ')}; no failure after that close yet`;
  }
  return 'unowned: no open or recently closed run mentions it';
}

/** CloudWatch reproduce command; the phrase is quoted for the filter pattern. */
export function reproduceCommand(g: SignalGroup, res: Pick<ProdSignalsResponse, 'awsProfile' | 'region' | 'windowHours'>): string {
  const phrase = g.searchPhrase.replace(/["\\]/g, ' ').trim();
  const since = `$(( ($(date +%s) - ${res.windowHours * 3600}) * 1000 ))`;
  return `aws logs filter-log-events --profile ${res.awsProfile} --region ${res.region} --log-group-name ${g.logGroup} --start-time ${since} --filter-pattern '"${phrase}"'`;
}

/** Text the operator pastes to Claude to open a run. The dashboard never opens runs itself. */
export function signalBrief(g: SignalGroup, res: Pick<ProdSignalsResponse, 'awsProfile' | 'region' | 'windowHours' | 'env'>): string {
  return [
    `Production signal (${res.env}) — ${g.product}, ${g.cluster} / ${g.service}`,
    `Signature: ${g.signature}`,
    `Failures: ${g.partialSince ? 'at least ' : ''}${g.failures} unique (${g.logLines} log lines) in the last ${res.windowHours}h; first ${ictTime(g.firstAt)}, last ${ictTime(g.lastAt)} ICT; ${g.hours} distinct hour${g.hours === 1 ? '' : 's'}${g.recurring ? ' (recurring)' : ''}${g.partialSince ? `; the log was read back to ${ictTime(g.partialSince)} ICT only` : ''}`,
    `Coverage: ${coverageLine(g)}`,
    ...(deployLine(g) ? [`Timing: ${deployLine(g)}`] : []),
    `Sample (redacted): ${g.sample}`,
    `Reproduce: ${reproduceCommand(g, res)}`,
    `Ask: decide whether this needs a TASK-${g.taskPrefix || '<PREFIX>'} run (Claude opens it), or attach it as evidence to the run that owns it.`,
  ].join('\n');
}
