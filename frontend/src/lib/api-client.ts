interface ApiEnvelope<T> {
  data: T | null;
  error: { message: string } | null;
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// Relative paths only — frontend and backend share an origin via Traefik
// (`/api` routes to the backend), so no base URL or CORS config is needed.
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      // Only set for requests that actually have a body — Fastify's
      // default JSON parser rejects an empty body sent with this
      // content-type (FST_ERR_CTP_EMPTY_JSON_BODY), which every
      // bodyless POST here (logout, e-stop) would otherwise hit.
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers
    }
  });

  const body = (await res.json()) as ApiEnvelope<T>;

  if (body.error) {
    throw new ApiError(body.error.message, res.status);
  }

  return body.data as T;
}
