export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "bad_response";

export function mapStatusToCode(status: number): ErrorCode {
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 429) {
    return "rate_limited";
  }
  return "bad_response";
}

export async function expectOkOr204(
  response: Response,
  context: string
): Promise<void> {
  if (response.ok || response.status === 204) {
    return;
  }
  const text = await response.text().catch(() => "");
  const code = mapStatusToCode(response.status);
  throw new Error(
    `${context}: ${response.status} ${response.statusText}${
      text ? ` - ${text}` : ""
    } [${code}]`
  );
}
