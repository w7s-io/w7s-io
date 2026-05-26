export type WorkflowEvent<Params = unknown> = {
  payload: Readonly<Params>;
  timestamp: Date;
  instanceId: string;
};

export type WorkflowStepContext = {
  step: {
    name: string;
    count: number;
  };
  attempt: number;
  config: unknown;
};

export type WorkflowStep = {
  do<T>(name: string, callback: (ctx: WorkflowStepContext) => Promise<T>): Promise<T>;
  do<T>(name: string, config: unknown, callback: (ctx: WorkflowStepContext) => Promise<T>): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
  waitForEvent<T>(name: string, options: { type: string; timeout?: string | number }): Promise<T>;
};

export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async run(_event: WorkflowEvent<Params>, _step: WorkflowStep): Promise<unknown> {
    throw new Error("WorkflowEntrypoint.run must be implemented by a subclass.");
  }
}
