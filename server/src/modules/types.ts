import type { FastifyInstance } from "fastify";

export interface BackendModule {
  readonly id: string;
  registerRoutes(app: FastifyInstance): void;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
