export const TICKET_RISKS = ["low", "medium", "high"] as const;
export type TicketRisk = (typeof TICKET_RISKS)[number];
export const DEFAULT_LABEL_PREFIX = "factory";

/** GitHub labels owned by Factory, e.g. `factory:ready`, `factory:done`, `factory:risk:low`. */
export function factoryLabels(prefix = DEFAULT_LABEL_PREFIX) {
  return { ready: `${prefix}:ready`, plan: `${prefix}:plan`, done: `${prefix}:done`, riskPrefix: `${prefix}:risk:` };
}

const RANK: Record<TicketRisk, number> = { low: 1, medium: 2, high: 3 };

export function riskLabel(risk: TicketRisk, prefix = DEFAULT_LABEL_PREFIX): string {
  return `${factoryLabels(prefix).riskPrefix}${risk}`;
}

/** Highest matching GitHub risk/severity label. Unrated issues are not low risk. */
export function ticketRisk(labels: readonly string[] | null | undefined, prefix = DEFAULT_LABEL_PREFIX): TicketRisk | null {
  let found: TicketRisk | null = null;
  for (const raw of labels ?? []) {
    const parsed = parseRiskLabel(raw, prefix);
    if (parsed && (!found || RANK[parsed] > RANK[found])) found = parsed;
  }
  return found;
}

export function isLowRisk(labels: readonly string[] | null | undefined, prefix = DEFAULT_LABEL_PREFIX): boolean {
  return ticketRisk(labels, prefix) === "low";
}

export function factoryRisk(labels: readonly string[] | null | undefined, prefix = DEFAULT_LABEL_PREFIX): TicketRisk | null {
  const riskPrefix = factoryLabels(prefix).riskPrefix;
  for (const raw of labels ?? []) {
    const value = raw.toLowerCase().trim();
    if (!value.startsWith(riskPrefix)) continue;
    const risk = value.slice(riskPrefix.length);
    if ((TICKET_RISKS as readonly string[]).includes(risk)) return risk as TicketRisk;
  }
  return null;
}

export function parseRiskLabel(label: string, prefix = DEFAULT_LABEL_PREFIX): TicketRisk | null {
  let value = label.toLowerCase().trim().replace(/\s+/g, "");
  if (value.startsWith(`${prefix}:`)) value = value.slice(prefix.length + 1);
  const match = /^(?:risk|severity)[:/=-](low|medium|high|critical)$/.exec(value);
  if (!match) return null;
  return match[1] === "critical" ? "high" : (match[1] as TicketRisk);
}
