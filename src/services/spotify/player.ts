import type { HttpClient } from "../http-client.ts";
import {
  CurrentlyPlayingCodec,
  DevicesResponseCodec,
  PlayerStateCodec,
  QueueResponseCodec,
} from "../../types/spotify.codecs.ts";
import { expectOkOr204 } from "../../utils/http-result.ts";
import { apiBase } from "../../utils/spotify.ts";

export type AuthHeaders = { Authorization: string };

function baseUrlWithSlash(baseUrl: string): string {
  return apiBase(baseUrl);
}

// Status APIs
export async function getPlayerState(
  http: HttpClient,
  baseUrl: string,
  headers: AuthHeaders,
  signal?: AbortSignal
) {
  const response = await http(
    new URL("me/player", baseUrlWithSlash(baseUrl)).toString(),
    {
      headers,
      signal,
    }
  );
  if (response.status === 204) {
    return null;
  }
  await expectOkOr204(response, "Fetch player state failed");
  return PlayerStateCodec.parse(await response.json());
}

export async function listDevices(
  http: HttpClient,
  baseUrl: string,
  headers: AuthHeaders,
  signal?: AbortSignal
) {
  const response = await http(
    new URL("me/player/devices", baseUrlWithSlash(baseUrl)).toString(),
    { headers, signal }
  );
  await expectOkOr204(response, "Fetch devices failed");
  return DevicesResponseCodec.parse(await response.json());
}

export async function getQueue(
  http: HttpClient,
  baseUrl: string,
  headers: AuthHeaders,
  signal?: AbortSignal
) {
  const response = await http(
    new URL("me/player/queue", baseUrlWithSlash(baseUrl)).toString(),
    {
      headers,
      signal,
    }
  );
  await expectOkOr204(response, "Fetch queue failed");
  return QueueResponseCodec.parse(await response.json());
}

export async function getCurrentlyPlaying(
  http: HttpClient,
  baseUrl: string,
  headers: AuthHeaders,
  signal?: AbortSignal
) {
  const response = await http(
    new URL(
      "me/player/currently-playing",
      baseUrlWithSlash(baseUrl)
    ).toString(),
    { headers, signal }
  );
  if (response.status === 204) {
    return null;
  }
  await expectOkOr204(response, "Fetch current track failed");
  return CurrentlyPlayingCodec.parse(await response.json());
}

// Control APIs
export async function play(
  http: HttpClient,
  baseUrl: string,
  headers: AuthHeaders,
  options: {
    device_id?: string;
    context_uri?: string;
    uris?: string[];
    offset?: { position?: number; uri?: string };
    position_ms?: number;
  },
  signal?: AbortSignal
) {
  const query = new URLSearchParams();
  if (options.device_id) {
    query.set("device_id", options.device_id);
  }
  const url = new URL("me/player/play", baseUrlWithSlash(baseUrl)).toString();
  const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;

  const body: Record<string, unknown> = {};
  if (options.context_uri) {
    body.context_uri = options.context_uri;
  }
  if (!options.context_uri && options.uris && options.uris.length > 0) {
    body.uris = options.uris;
  }
  if (options.offset?.position != null) {
    body.offset = { position: options.offset.position };
  } else if (options.offset?.uri) {
    body.offset = { uri: options.offset.uri };
  }
  if (typeof options.position_ms === "number") {
    body.position_ms = options.position_ms;
  }

  const response = await http(fullUrl, {
    method: "PUT",
    headers,
    body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
    signal,
  });
  await expectOkOr204(response, "Play failed");
}

export async function pause(
  http: HttpClient,
  baseUrl: string,
  headers: AuthHeaders,
  options: { device_id?: string },
  signal?: AbortSignal
) {
  const query = new URLSearchParams();
  if (options.device_id) {
    query.set("device_id", options.device_id);
  }
  const url = new URL("me/player/pause", baseUrlWithSlash(baseUrl)).toString();
  const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
  const response = await http(fullUrl, { method: "PUT", headers, signal });
  await expectOkOr204(response, "Pause failed");
}

export async function next(
  http: HttpClient,
  baseUrl: string,
  headers: AuthHeaders,
  options: { device_id?: string },
  signal?: AbortSignal
) {
  const query = new URLSearchParams();
  if (options.device_id) {
    query.set("device_id", options.device_id);
  }
  const url = new URL("me/player/next", baseUrlWithSlash(baseUrl)).toString();
  const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
  const response = await http(fullUrl, { method: "POST", headers, signal });
  await expectOkOr204(response, "Skip to next failed");
}

export async function previous(
  http: HttpClient,
  baseUrl: string,
  headers: AuthHeaders,
  options: { device_id?: string },
  signal?: AbortSignal
) {
  const query = new URLSearchParams();
  if (options.device_id) {
    query.set("device_id", options.device_id);
  }
  const url = new URL(
    "me/player/previous",
    baseUrlWithSlash(baseUrl)
  ).toString();
  const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
  const response = await http(fullUrl, { method: "POST", headers, signal });
  await expectOkOr204(response, "Skip to previous failed");
}

export async function seek(
  http: HttpClient,
  baseUrl: string,
  headers: AuthHeaders,
  position_ms: number,
  options: { device_id?: string },
  signal?: AbortSignal
) {
  const query = new URLSearchParams();
  query.set("position_ms", String(position_ms));
  if (options.device_id) {
    query.set("device_id", options.device_id);
  }
  const url = new URL("me/player/seek", baseUrlWithSlash(baseUrl)).toString();
  const response = await http(`${url}?${query.toString()}`, {
    method: "PUT",
    headers,
    signal,
  });
  await expectOkOr204(response, "Seek failed");
}

export async function shuffle(
  http: HttpClient,
  baseUrl: string,
  headers: AuthHeaders,
  state: boolean,
  options: { device_id?: string },
  signal?: AbortSignal
) {
  const query = new URLSearchParams();
  query.set("state", String(state));
  if (options.device_id) {
    query.set("device_id", options.device_id);
  }
  const url = new URL(
    "me/player/shuffle",
    baseUrlWithSlash(baseUrl)
  ).toString();
  const response = await http(`${url}?${query.toString()}`, {
    method: "PUT",
    headers,
    signal,
  });
  await expectOkOr204(response, "Set shuffle failed");
}

export async function repeat(
  http: HttpClient,
  baseUrl: string,
  headers: AuthHeaders,
  state: "off" | "track" | "context",
  options: { device_id?: string },
  signal?: AbortSignal
) {
  const query = new URLSearchParams();
  query.set("state", state);
  if (options.device_id) {
    query.set("device_id", options.device_id);
  }
  const url = new URL("me/player/repeat", baseUrlWithSlash(baseUrl)).toString();
  const response = await http(`${url}?${query.toString()}`, {
    method: "PUT",
    headers,
    signal,
  });
  await expectOkOr204(response, "Set repeat failed");
}

export async function volume(
  http: HttpClient,
  baseUrl: string,
  headers: AuthHeaders,
  volume_percent: number,
  options: { device_id?: string },
  signal?: AbortSignal
) {
  const vol = Math.max(0, Math.min(100, volume_percent));
  const query = new URLSearchParams();
  query.set("volume_percent", String(vol));
  if (options.device_id) {
    query.set("device_id", options.device_id);
  }
  const url = new URL("me/player/volume", baseUrlWithSlash(baseUrl)).toString();
  const response = await http(`${url}?${query.toString()}`, {
    method: "PUT",
    headers,
    signal,
  });
  await expectOkOr204(response, "Set volume failed");
}

export async function transfer(
  http: HttpClient,
  baseUrl: string,
  headers: AuthHeaders,
  device_id: string,
  transfer_play = false,
  signal?: AbortSignal
) {
  const body = JSON.stringify({ device_ids: [device_id], play: transfer_play });
  const response = await http(
    new URL("me/player", baseUrlWithSlash(baseUrl)).toString(),
    {
      method: "PUT",
      headers,
      body,
      signal,
    }
  );
  await expectOkOr204(response, "Transfer playback failed");
}

export async function queueUri(
  http: HttpClient,
  baseUrl: string,
  headers: AuthHeaders,
  queue_uri: string,
  options: { device_id?: string },
  signal?: AbortSignal
) {
  const query = new URLSearchParams();
  query.set("uri", queue_uri);
  if (options.device_id) {
    query.set("device_id", options.device_id);
  }
  const url = new URL("me/player/queue", baseUrlWithSlash(baseUrl)).toString();
  const response = await http(`${url}?${query.toString()}`, {
    method: "POST",
    headers,
    signal,
  });
  await expectOkOr204(response, "Queue failed");
}
