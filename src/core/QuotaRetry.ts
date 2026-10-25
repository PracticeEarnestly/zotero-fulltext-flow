// The service's reset time is unknown. This is a conservative local schedule,
// not a claim about the provider's quota or timezone.
export function isDailyQuotaError(message: string): boolean {
  return String(message || "").includes("当日传递次数已达上限");
}

export function nextQuotaAttempt(now = new Date()): string {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 10, 0, 0);
  return next.toISOString();
}
