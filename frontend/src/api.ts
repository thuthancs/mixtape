const BASE_URL = 'https://studio-api.prod.suno.com/api/v2/external/hackathons/';

function getApiKey(): string {
  const key = import.meta.env.VITE_SUNO_API_KEY;
  if (!key || typeof key !== 'string') {
    throw new Error('VITE_SUNO_API_KEY is not set. Add it to your .env file.');
  }
  return key;
}

function getHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    'Content-Type': 'application/json',
  };
}

export type GenerateBody = {
  topic?: string;
  tags?: string;
  negative_tags?: string;
  prompt?: string;
  make_instrumental?: boolean;
};

export type Clip = {
  id: string;
  request_id?: string;
  status: 'submitted' | 'queued' | 'streaming' | 'complete' | 'error';
  title?: string;
  audio_url?: string;
  image_url?: string;
  image_large_url?: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
};

export class SunoApiError extends Error {
  status?: number;
  detail?: string;
  constructor(message: string, status?: number, detail?: string) {
    super(message);
    this.name = 'SunoApiError';
    this.status = status;
    this.detail = detail;
  }
}

export async function generate(body: GenerateBody): Promise<Clip> {
  const res = await fetch(`${BASE_URL}generate`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail: string | undefined;
    try {
      const json = (await res.json()) as { detail?: string };
      detail = json.detail;
    } catch {
      detail = res.statusText;
    }
    if (res.status === 401) throw new SunoApiError('Invalid API key', 401, detail);
    if (res.status === 403) throw new SunoApiError('Access denied', 403, detail);
    if (res.status === 429) throw new SunoApiError('Rate limit exceeded. Please wait.', 429, detail);
    if (res.status === 400) throw new SunoApiError(detail ?? 'Bad request', 400, detail);
    throw new SunoApiError(detail ?? `Request failed (${res.status})`, res.status, detail);
  }

  return (await res.json()) as Clip;
}

export async function getClips(ids: string[]): Promise<Clip[]> {
  if (ids.length === 0) return [];
  const idsParam = ids.join(',');
  const res = await fetch(`${BASE_URL}clips?ids=${encodeURIComponent(idsParam)}`, {
    method: 'GET',
    headers: getHeaders(),
  });

  if (!res.ok) {
    let detail: string | undefined;
    try {
      const json = (await res.json()) as { detail?: string };
      detail = json.detail;
    } catch {
      detail = res.statusText;
    }
    if (res.status === 401) throw new SunoApiError('Invalid API key', 401, detail);
    if (res.status === 403) throw new SunoApiError('Access denied', 403, detail);
    if (res.status === 429) throw new SunoApiError('Rate limit exceeded', 429, detail);
    throw new SunoApiError(detail ?? `Request failed (${res.status})`, res.status, detail);
  }

  return (await res.json()) as Clip[];
}

export async function separateStems(clipId: string): Promise<Clip[]> {
  const res = await fetch(`${BASE_URL}stem`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ clip_id: clipId }),
  });

  if (!res.ok) {
    let detail: string | undefined;
    try {
      const json = (await res.json()) as { detail?: string };
      detail = json.detail;
    } catch {
      detail = res.statusText;
    }
    if (res.status === 401) throw new SunoApiError('Invalid API key', 401, detail);
    if (res.status === 403) throw new SunoApiError('Access denied', 403, detail);
    if (res.status === 429) throw new SunoApiError('Stem separation rate limit exceeded. Please wait.', 429, detail);
    if (res.status === 400) throw new SunoApiError(detail ?? 'Bad request', 400, detail);
    throw new SunoApiError(detail ?? `Request failed (${res.status})`, res.status, detail);
  }

  const data = (await res.json()) as Clip[];
  return Array.isArray(data) ? data : [];
}
