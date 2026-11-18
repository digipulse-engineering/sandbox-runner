// workerd clamps both setTimeout and AbortSignal.timeout to this delay.
// https://github.com/cloudflare/workerd/blob/main/src/workerd/io/io-context.c%2B%2B#L1210-L1225
export const maxAgentTimeoutMs = 3_153_600_000_000;

export type AgentDeadline = { admittedAt: number; deadlineAt: number; timeoutMs?: number };
export type AgentDeadlineError = "agent_deadline_invalid" | "run_timeout_exceeds_limit";

export const agentTimeoutOutcome = { status: "timed_out", reason: "run_timed_out" } as const;

export function isAgentTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maxAgentTimeoutMs;
}

function parseAgentTimeoutSetting(value: string): number | undefined {
  const timeout = Number(value);
  if (value.trim() === value && /^\d+$/.test(value) && isAgentTimeoutMs(timeout)) return timeout;
}

export function resolveAgentDeadline(
  timeoutMs: number | undefined, configured: string | undefined, admittedAt: number,
): AgentDeadline | AgentDeadlineError | undefined {
  const maximum = configured === undefined ? undefined : parseAgentTimeoutSetting(configured);
  if (configured !== undefined && maximum === undefined) return "agent_deadline_invalid";
  if (timeoutMs !== undefined && maximum !== undefined && timeoutMs > maximum) return "run_timeout_exceeds_limit";
  const effectiveTimeout = timeoutMs ?? maximum;
  if (effectiveTimeout !== undefined) return { admittedAt, deadlineAt: admittedAt + effectiveTimeout, timeoutMs };
}

export function deadlineReached(deadline: AgentDeadline | undefined, now = Date.now()): boolean {
  return deadline !== undefined && now >= deadline.deadlineAt;
}

export function sameAgentDeadline(left: AgentDeadline | undefined, right: AgentDeadline | undefined): boolean {
  return left?.admittedAt === right?.admittedAt && left?.deadlineAt === right?.deadlineAt && left?.timeoutMs === right?.timeoutMs;
}

export function deadlineView(deadline: AgentDeadline | undefined): { deadlineAt?: number } {
  return deadline === undefined ? {} : { deadlineAt: deadline.deadlineAt };
}

// Bound both directions of the opaque stream at the final outbound call.
export function runDeadlineFetch(fetcher: typeof fetch, deadlineAt: number | undefined): typeof fetch {
  if (deadlineAt === undefined) return fetcher;
  return (target, init) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("Agent egress deadline elapsed");
    const timeout = AbortSignal.timeout(remaining);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetcher(target, { ...init, signal });
  };
}

export const deadlineElapsed = Symbol("agent-deadline-elapsed");

/** Race an operation without granting its late reply authority to commit state. */
export async function beforeAgentDeadline<T>(
  run: () => Promise<T>, deadline: AgentDeadline | undefined,
): Promise<T | typeof deadlineElapsed> {
  if (deadline === undefined) return run();
  const remaining = deadline.deadlineAt - Date.now();
  if (remaining <= 0) return deadlineElapsed;
  const { promise, resolve } = Promise.withResolvers<typeof deadlineElapsed>();
  const timer = setTimeout(() => resolve(deadlineElapsed), remaining);
  try {
    const value = await Promise.race([run(), promise]);
    return deadlineReached(deadline) ? deadlineElapsed : value;
  } finally {
    clearTimeout(timer);
  }
}
