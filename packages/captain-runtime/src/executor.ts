import type { CaptainAdmissionController } from "./admission.ts";
import type { CaptainLaneRegistry } from "./registry.ts";
import { captainLaneKey, type CaptainLaneAddress } from "./types.ts";

export interface CaptainLaneExecutionContext {
  readonly signal: AbortSignal;
  readonly continuationToken?: string;
}

export interface CaptainLaneExecutionResult<T> {
  readonly output: T;
  readonly sessionId: string;
  readonly continuationToken?: string;
}

export interface CaptainLaneDispatch<T> {
  readonly address: CaptainLaneAddress;
  readonly requestId: string;
  readonly sessionId: string;
  readonly continuationToken?: string;
  readonly signal?: AbortSignal;
  execute(context: CaptainLaneExecutionContext): Promise<CaptainLaneExecutionResult<T>>;
  route(result: { readonly address: CaptainLaneAddress; readonly output: T }): void | Promise<void>;
}

/**
 * Composes secret lane ownership, provider admission, and response routing.
 * Each callback receives only its own lane's resume token and route address.
 */
export class CaptainLaneExecutor {
  private readonly registry: CaptainLaneRegistry;
  private readonly admission: CaptainAdmissionController;

  public constructor(registry: CaptainLaneRegistry, admission: CaptainAdmissionController) {
    this.registry = registry;
    this.admission = admission;
  }

  public async dispatch<T>(input: CaptainLaneDispatch<T>): Promise<T> {
    await this.registry.register(input.address);
    await this.registry.bindSession(input.address, {
      sessionId: input.sessionId,
      ...(input.continuationToken === undefined ? {} : { continuationToken: input.continuationToken }),
    });
    const resume = this.registry.resumeState(input.address);
    const result = await this.admission.execute(
      {
        requestId: input.requestId,
        laneKey: captainLaneKey(input.address),
        lane: input.address.lane === "tui" ? "operator" : input.address.lane,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      (signal) =>
        input.execute({
          signal,
          ...(resume?.continuationToken === undefined ? {} : { continuationToken: resume.continuationToken }),
        }),
    );
    const nextToken = result.continuationToken ?? resume?.continuationToken;
    await this.registry.bindSession(input.address, {
      sessionId: result.sessionId,
      ...(nextToken === undefined ? {} : { continuationToken: nextToken }),
    });
    await input.route({ address: input.address, output: result.output });
    return result.output;
  }
}
