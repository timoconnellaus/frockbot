export interface SidebarBotGroupV1<T> {
  key: string;
  label: string;
  bots: T[];
}

export interface GroupedSidebarBotsV1<T> {
  showHeadings: boolean;
  groups: SidebarBotGroupV1<T>[];
}

/**
 * Groups labels by their case-insensitive trimmed value while preserving the
 * spelling of the first Bot in each group. Unassigned is always last. Until a
 * visible Bot has a label, the sidebar remains one plain list with no heading.
 */
export function groupSidebarBotsV1<T extends { botId: string }>(
  bots: readonly T[],
  profiles: Readonly<Record<string, { label?: string } | undefined>>,
): GroupedSidebarBotsV1<T> {
  const labelled = new Map<string, SidebarBotGroupV1<T>>();
  const unassigned: T[] = [];
  for (const bot of bots) {
    const label = profiles[bot.botId]?.label?.trim() ?? "";
    if (!label) {
      unassigned.push(bot);
      continue;
    }
    const key = label.toLowerCase();
    const group = labelled.get(key);
    if (group) group.bots.push(bot);
    else labelled.set(key, { key: `label:${key}`, label, bots: [bot] });
  }
  if (labelled.size === 0) {
    return {
      showHeadings: false,
      groups: [{ key: "all", label: "", bots: [...bots] }],
    };
  }
  return {
    showHeadings: true,
    groups: [
      ...labelled.values(),
      ...(unassigned.length === 0
        ? []
        : [{ key: "unassigned", label: "Unassigned", bots: unassigned }]),
    ],
  };
}

/** GrokBot-style local time label for the sidebar's latest message. */
export function formatSidebarMessageTimeV1(
  at: string,
  now: Date = new Date(),
  locale?: string,
): string {
  const message = new Date(at);
  if (!Number.isFinite(message.getTime())) return "";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (message >= today && message < tomorrow) {
    return new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
    }).format(message);
  }
  const week = new Date(today);
  week.setDate(week.getDate() - 6);
  if (message >= week && message < tomorrow) {
    return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(message);
  }
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
  }).format(message);
}
