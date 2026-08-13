const DEFAULT_ARM_LEAD_MS = 60_000;
const DEFAULT_REVALIDATE_LEAD_MS = 5_000;

function boundedEnvMs(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : fallback;
}

export function armLeadMs(): number {
  return boundedEnvMs("MINT_ARM_LEAD_MS", DEFAULT_ARM_LEAD_MS, 5_000, 300_000);
}

export function revalidateLeadMs(): number {
  return boundedEnvMs("MINT_REVALIDATE_LEAD_MS", DEFAULT_REVALIDATE_LEAD_MS, 1_000, 30_000);
}

export function millisecondsUntil(targetAt: string, now = Date.now()): number {
  const target = Date.parse(targetAt);
  if (!Number.isFinite(target)) throw new Error("Launch target is not a valid timestamp");
  return target - now;
}

/**
 * Node timers may wake early. Re-arm short timers until wall-clock time reaches
 * the contract timestamp; this avoids both a coarse polling delay and an early
 * FCFS submission.
 */
export function schedulePrecisely(targetAt: string, callback: (firedAt: number) => void): ReturnType<typeof setTimeout> {
  const target = Date.parse(targetAt);
  if (!Number.isFinite(target)) throw new Error("Launch target is not a valid timestamp");
  let timer: ReturnType<typeof setTimeout>;
  const check = () => {
    const remaining = target - Date.now();
    if (remaining <= 0) callback(Date.now());
    else timer = setTimeout(check, Math.max(1, Math.min(remaining, 1_000)));
  };
  timer = setTimeout(check, Math.max(0, Math.min(target - Date.now(), 2_147_483_647)));
  return timer;
}

export function timingDriftMs(targetAt: string, firedAt: number): number {
  return Math.max(0, firedAt - Date.parse(targetAt));
}
