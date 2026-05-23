export const json = (payload: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers
    }
  });

export const jsonError = (error: string, status = 400, details?: Record<string, unknown>) =>
  json(
    {
      status: "error",
      error,
      ...(details ? { details } : {})
    },
    status
  );

export const jsonSuccess = (data: Record<string, unknown>, status = 200) =>
  json(
    {
      status: "success",
      data
    },
    status
  );

export const parseBearerToken = (request: Request) => {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() ?? "";
  return token || null;
};

