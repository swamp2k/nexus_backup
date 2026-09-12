import { createApi, type Env } from "./api.js";

export * from "./agent-store.js";
export * from "./api.js";
export * from "./d1-job-repository.js";
export * from "./d1-types.js";

const api = createApi();

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return api.fetch(request, env);
  },
  scheduled(_controller: unknown, env: Env, ctx: ExecutionContextLike): void {
    ctx.waitUntil(api.recover(env));
  },
};
