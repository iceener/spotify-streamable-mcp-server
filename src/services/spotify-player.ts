import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { spotifyCall } from './spotify';
import {
  CurrentlyPlayingCodec,
  DevicesResponseCodec,
  PlayerStateCodec,
  QueueResponseCodec,
} from './spotify-codecs';

/**
 * Spotify Connect: player state and playback commands, as the signed-in user. A command that
 * Spotify accepts (204) is not proof that playback changed; `tools/shared/playback.ts` reads
 * the state back before a tool reports success.
 */

export type PlayerState = Awaited<ReturnType<typeof getPlayerState>>;

/** The current playback state, or `null` when Spotify is not active anywhere (204). */
export async function getPlayerState(api: SpotifyApi) {
  const result = await spotifyCall(() => api.makeRequest<unknown>('GET', 'me/player'));
  return result === null ? null : PlayerStateCodec.parse(result);
}

export async function listDevices(api: SpotifyApi) {
  const result = await spotifyCall(() => api.makeRequest<unknown>('GET', 'me/player/devices'));
  return DevicesResponseCodec.parse(result);
}

export async function getQueue(api: SpotifyApi) {
  const result = await spotifyCall(() => api.makeRequest<unknown>('GET', 'me/player/queue'));
  return QueueResponseCodec.parse(result);
}

export async function getCurrentlyPlaying(api: SpotifyApi) {
  const result = await spotifyCall(() =>
    api.makeRequest<unknown>('GET', 'me/player/currently-playing'),
  );
  return result === null ? null : CurrentlyPlayingCodec.parse(result);
}

export async function play(
  api: SpotifyApi,
  options: {
    device_id?: string | undefined;
    context_uri?: string | undefined;
    uris?: string[] | undefined;
    offset?: { position?: number | undefined; uri?: string | undefined } | undefined;
    position_ms?: number | undefined;
  },
): Promise<void> {
  await spotifyCall(() =>
    api.player.startResumePlayback(
      options.device_id ?? '',
      options.context_uri,
      options.uris,
      options.offset as object | undefined,
      options.position_ms,
    ),
  );
}

export async function pause(api: SpotifyApi, deviceId: string | undefined): Promise<void> {
  await spotifyCall(() => api.player.pausePlayback(deviceId ?? ''));
}

export async function next(api: SpotifyApi, deviceId: string | undefined): Promise<void> {
  await spotifyCall(() => api.player.skipToNext(deviceId ?? ''));
}

export async function previous(api: SpotifyApi, deviceId: string | undefined): Promise<void> {
  await spotifyCall(() => api.player.skipToPrevious(deviceId ?? ''));
}

export async function seek(
  api: SpotifyApi,
  positionMs: number,
  deviceId: string | undefined,
): Promise<void> {
  await spotifyCall(() => api.player.seekToPosition(positionMs, deviceId));
}

export async function shuffle(
  api: SpotifyApi,
  state: boolean,
  deviceId: string | undefined,
): Promise<void> {
  await spotifyCall(() => api.player.togglePlaybackShuffle(state, deviceId));
}

export async function repeat(
  api: SpotifyApi,
  state: 'off' | 'track' | 'context',
  deviceId: string | undefined,
): Promise<void> {
  await spotifyCall(() => api.player.setRepeatMode(state, deviceId));
}

export async function volume(
  api: SpotifyApi,
  percent: number,
  deviceId: string | undefined,
): Promise<void> {
  await spotifyCall(() =>
    api.player.setPlaybackVolume(Math.max(0, Math.min(100, percent)), deviceId),
  );
}

export async function transfer(api: SpotifyApi, deviceId: string, play = false): Promise<void> {
  await spotifyCall(() => api.player.transferPlayback([deviceId], play));
}

export async function queue(
  api: SpotifyApi,
  uri: string,
  deviceId: string | undefined,
): Promise<void> {
  await spotifyCall(() => api.player.addItemToPlaybackQueue(uri, deviceId));
}
