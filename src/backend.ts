// Portal builds host the client separately from the authoritative game server.
// The regular website keeps using relative, same-origin URLs.
const configuredBackend = import.meta.env.VITE_BACKEND_URL as string | undefined;
export const backendOrigin = configuredBackend ? new URL(configuredBackend).origin : '';

export function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  if (!path.startsWith('/api/')) throw new Error('Expected an API path');
  return fetch(`${backendOrigin}${path}`, {
    ...options,
    credentials: backendOrigin ? 'include' : options?.credentials ?? 'same-origin',
  });
}

export function gameServerUrl(): string {
  const url = new URL('/ws/instagib', backendOrigin || window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
