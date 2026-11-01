import type { TrackerMcpAdapter, ProviderRequestBudget } from "./ports/tracker-mcp.ts";
import {
  executeLinearGraphql,
  LINEAR_GRAPHQL_RECONNECT,
  LINEAR_GRAPHQL_TOOL,
  linearGraphqlCredential,
  LinearGraphqlRefusal,
  planLinearGraphql,
  type LinearGraphqlPlan,
} from "./linear-graphql.ts";
import { isLinearWorkerTool, LINEAR_WORKER_TOOLS, publishLinearWorker } from "./linear-publishing.ts";
import { LinearRequestBudget, LinearRequestBudgetRefused } from "./linear-request-budget.ts";
import { compactLinearWrite } from "./linear-write-receipt.ts";

const budget = (requestBudget: ProviderRequestBudget | undefined) =>
  requestBudget instanceof LinearRequestBudget ? { requestBudget } : {};

/** Linear's part of the MCP host: its GraphQL escape hatch, worker publishing and budget (ADR 0328). */
export const linearMcp: TrackerMcpAdapter<LinearGraphqlPlan> = {
  graphql: {
    tool: LINEAR_GRAPHQL_TOOL,
    reconnect: LINEAR_GRAPHQL_RECONNECT,
    plan: planLinearGraphql,
    refusal: (error) => (error instanceof LinearGraphqlRefusal ? error : undefined),
    credential: linearGraphqlCredential,
    execute: ({ requestBudget, ...input }) => executeLinearGraphql({ ...input, ...budget(requestBudget) }),
  },
  workerTools: LINEAR_WORKER_TOOLS,
  isWorkerTool: isLinearWorkerTool,
  publishWorker: ({ requestBudget, ...input }) => publishLinearWorker({ ...input, ...budget(requestBudget) }),
  compactWrite: compactLinearWrite,
  budgetRefusal: (error) => (error instanceof LinearRequestBudgetRefused ? error : undefined),
};
