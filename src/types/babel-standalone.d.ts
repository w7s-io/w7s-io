declare module "@babel/standalone" {
  export function transform(
    code: string,
    options?: Record<string, unknown>
  ): {
    code?: string | null;
  };
}
