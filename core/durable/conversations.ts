/** Each Bot has one continuous chat Session. Routines and child Turns use their own ids. */
export function botConversationBaseSessionIdV1(identity: {
  userId: string;
  botId: string;
}): string {
  return `${identity.userId}:${identity.botId}`;
}
