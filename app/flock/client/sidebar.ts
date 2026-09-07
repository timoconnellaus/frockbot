export interface PinnedSidebarBotsV1<T> {
  /** Pinned Bots, earliest pin first. Rendered as tiles above the list. */
  pinned: T[];
  /** Everything else, in the order it arrived. */
  rest: T[];
}

/**
 * Splits the pinned Bots out of the sidebar list. A pinned Bot is a tile at
 * the top instead of a row below, never both, so the list this returns is what
 * {@link groupSidebarBotsV1} then groups by label.
 *
 * Order is by pin time — earliest first — because the tile row is a place a
 * User builds up over time and a Bot pinned today must not displace the one
 * they pinned last month. Ties and unparseable instants keep list order.
 */
export function partitionPinnedSidebarBotsV1<T extends { botId: string }>(
  bots: readonly T[],
  profiles: Readonly<Record<string, { pinnedAt?: string } | undefined>>,
): PinnedSidebarBotsV1<T> {
  const pinned: Array<{ bot: T; at: number; index: number }> = [];
  const rest: T[] = [];
  for (const [index, bot] of bots.entries()) {
    const pinnedAt = profiles[bot.botId]?.pinnedAt?.trim();
    if (!pinnedAt) {
      rest.push(bot);
      continue;
    }
    const at = Date.parse(pinnedAt);
    pinned.push({ bot, at: Number.isFinite(at) ? at : 0, index });
  }
  pinned.sort((left, right) =>
    left.at === right.at ? left.index - right.index : left.at - right.at,
  );
  return { pinned: pinned.map((entry) => entry.bot), rest };
}

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
