import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import {
  CurrentlyPlayingCodec,
  DevicesResponseCodec,
  PlayerStateCodec,
  QueueResponseCodec,
} from '../../types/spotify.codecs.ts';
import { mapStatusToCode } from '../../utils/http-result.ts';

// Status APIs
export async function getPlayerState(api: SpotifyApi) {
  const result = await callWithHandling(() =>
    api.makeRequest<unknown>('GET', 'me/player'),
  );
  if (result === null) {
    return null;
  }
  return PlayerStateCodec.parse(result);
}

export async function listDevices(api: SpotifyApi) {
  const result = await callWithHandling(() =>
    api.makeRequest<unknown>('GET', 'me/player/devices'),
  );
  return DevicesResponseCodec.parse(result);
}

export async function getQueue(api: SpotifyApi) {
  const result = await callWithHandling(() =>
    api.makeRequest<unknown>('GET', 'me/player/queue'),
  );
  return QueueResponseCodec.parse(result);
}

export async function getCurrentlyPlaying(api: SpotifyApi) {
  const result = await callWithHandling(() =>
    api.makeRequest<unknown>('GET', 'me/player/currently-playing'),
  );
  if (result === null) {
    return null;
  }
  return CurrentlyPlayingCodec.parse(result);
}

// Control APIs
export async function play(
  api: SpotifyApi,
  options: {
    device_id?: string;
    context_uri?: string;
    uris?: string[];
    offset?: { position?: number; uri?: string };
    position_ms?: number;
  },
) {
  await callWithHandling(() =>
    api.player.startResumePlayback(
      options.device_id ?? '',
      options.context_uri,
      options.uris,
      options.offset,
      options.position_ms,
    ),
  );
}

export async function pause(api: SpotifyApi, options: { device_id?: string }) {
  await callWithHandling(() => api.player.pausePlayback(options.device_id ?? ''));
}

export async function next(api: SpotifyApi, options: { device_id?: string }) {
  await callWithHandling(() => api.player.skipToNext(options.device_id ?? ''));
}

export async function previous(api: SpotifyApi, options: { device_id?: string }) {
  await callWithHandling(() => api.player.skipToPrevious(options.device_id ?? ''));
}

export async function seek(
  api: SpotifyApi,
  position_ms: number,
  options: { device_id?: string },
) {
  await callWithHandling(() =>
    api.player.seekToPosition(position_ms, options.device_id),
  );
}

export async function shuffle(
  api: SpotifyApi,
  state: boolean,
  options: { device_id?: string },
) {
  await callWithHandling(() =>
    api.player.togglePlaybackShuffle(state, options.device_id),
  );
}

export async function repeat(
  api: SpotifyApi,
  state: 'off' | 'track' | 'context',
  options: { device_id?: string },
) {
  await callWithHandling(() => api.player.setRepeatMode(state, options.device_id));
}

export async function volume(
  api: SpotifyApi,
  volume_percent: number,
  options: { device_id?: string },
) {
  const vol = Math.max(0, Math.min(100, volume_percent));
  await callWithHandling(() => api.player.setPlaybackVolume(vol, options.device_id));
}

export async function transfer(
  api: SpotifyApi,
  device_id: string,
  transfer_play = false,
) {
  await callWithHandling(() => api.player.transferPlayback([device_id], transfer_play));
}

export async function queueUri(
  api: SpotifyApi,
  queue_uri: string,
  options: { device_id?: string },
) {
  await callWithHandling(() =>
    api.player.addItemToPlaybackQueue(queue_uri, options.device_id),
  );
}

function callWithHandling<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((error) => {
    throw decorateSpotifyError(error);
  });
}

function decorateSpotifyError(error: unknown): Error {
  const status = (error as { status?: number }).status;
  if (typeof status === 'number') {
    const code = mapStatusToCode(status);
    const rawMessage = (error as Error).message;
    const cleaned = rawMessage.replace(/\s*\[[^\]]+\]$/, '');
    const err = new Error(`${cleaned} [${code}]`);
    (err as { status?: number }).status = status;
    return err;
  }
  return error instanceof Error ? error : new Error(String(error));
}
