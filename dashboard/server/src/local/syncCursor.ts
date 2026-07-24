import fs from 'fs/promises';
import path from 'path';

// Durable sync cursor for the Local-side changes feed: tracks the last
// change_seq consumed so a refresh only fetches newer changes (Decision #14).
// Same atomic-write pattern as services/decisionStore.ts (tmp + fsync + rename).

export async function readCursor(cursorPath: string): Promise<number> {
  try {
    const data = JSON.parse(await fs.readFile(cursorPath, 'utf8'));
    return Number.isFinite(data?.seq) && data.seq >= 0 ? data.seq : 0;
  } catch {
    return 0;
  }
}

let tmpCounter = 0;

export async function writeCursor(cursorPath: string, seq: number): Promise<void> {
  await fs.mkdir(path.dirname(cursorPath), { recursive: true });
  const tmp = `${cursorPath}.tmp.${process.pid}.${tmpCounter++}`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify({ seq }), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, cursorPath);
}
