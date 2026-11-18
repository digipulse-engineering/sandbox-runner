export type McpInitializeResult = {
  readonly protocolVersion: string;
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly capabilities: { readonly tools: Record<string, never> };
  readonly instructions?: string;
};

export type McpUpstreamSession = {
  readonly id: string;
  readonly upstreamId?: string;
  readonly protocolVersion?: string;
  readonly awaitingAcknowledgement?: true;
};

export type McpInitializeReply = {
  readonly requestedVersion: string;
  readonly result: McpInitializeResult;
};

type StoredSession = Omit<McpUpstreamSession, "awaitingAcknowledgement"> & { readonly reply?: McpInitializeReply };

export type McpSessionAccess = {
  read(): Promise<McpUpstreamSession | undefined>;
  claim(id: string, replaces?: string): Promise<boolean>;
  commit(id: string, upstreamId: string, protocolVersion: string, reply?: McpInitializeReply): Promise<boolean>;
  replay(id: string, requestedVersion: string): Promise<McpInitializeResult | undefined>;
  acknowledge(id: string): Promise<boolean>;
  release(id: string, pendingOnly?: true): Promise<boolean>;
};

type SessionStorage = Pick<DurableObjectStorage, "get" | "transaction">;

export function mcpSession(
  storage: SessionStorage, key: string, allowed: (transaction: DurableObjectTransaction) => Promise<boolean>,
): McpSessionAccess {
  return {
    async read() {
      const current = await storage.get<StoredSession>(key);
      if (!current) return;
      const { reply, ...session } = current;
      return reply ? { ...session, awaitingAcknowledgement: true } : session;
    },
    claim: (id, replaces) => storage.transaction(async transaction => {
      if (!await allowed(transaction)) return false;
      const current = await transaction.get<StoredSession>(key);
      // A retry may replace only the pending reservation it observed.
      if (current?.id !== replaces || current?.upstreamId !== undefined) return false;
      await transaction.put(key, { id } satisfies StoredSession);
      return true;
    }),
    commit: (id, upstreamId, protocolVersion, reply) => storage.transaction(async transaction => {
      if (!await allowed(transaction)) return false;
      const current = await transaction.get<StoredSession>(key);
      if (current?.id !== id || current.upstreamId !== undefined) return false;
      await transaction.put(key, { id, upstreamId, protocolVersion, ...(reply ? { reply } : {}) } satisfies StoredSession);
      return true;
    }),
    replay: (id, requestedVersion) => storage.transaction(async transaction => {
      if (!await allowed(transaction)) return;
      const current = await transaction.get<StoredSession>(key);
      if (current?.id === id && current.reply?.requestedVersion === requestedVersion) return current.reply.result;
    }),
    acknowledge: id => storage.transaction(async transaction => {
      if (!await allowed(transaction)) return false;
      const current = await transaction.get<StoredSession>(key);
      if (current?.id !== id || current.upstreamId === undefined) return false;
      const { reply, ...established } = current;
      if (reply) await transaction.put(key, established);
      return true;
    }),
    release: (id, pendingOnly) => storage.transaction(async transaction => {
      const current = await transaction.get<StoredSession>(key);
      if (current?.id !== id || (pendingOnly && current.upstreamId !== undefined)) return false;
      return transaction.delete(key);
    }),
  };
}
