// The Group Chats a Bot is a member of, which are the Group Chat Memory scopes
// it may read and write. The list lives in the User Durable Object; a Bot
// that leaves a group loses its Memory with the membership.

export interface MemoryGroupsV1 {
  memberOf(): Promise<string[]>;
}
