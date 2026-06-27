import type { ProactivityStore } from "../core/types.js";

export type PostgresStoreConfig = {
  connectionString: string;
  schema?: string;
};

export const createPostgresStore = (_config: PostgresStoreConfig): ProactivityStore => {
  throw new Error("Not implemented");
};
