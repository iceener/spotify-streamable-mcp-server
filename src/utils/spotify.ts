export function apiBase(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
