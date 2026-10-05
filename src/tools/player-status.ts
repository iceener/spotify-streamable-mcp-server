import { defineTool } from '../platform/primitives';
import {
  getCurrentlyPlaying,
  getPlayerState,
  getQueue,
  listDevices,
} from '../services/spotify-player';
import { SpotifyStatusInputSchema } from './shared/inputs';
import { SpotifyStatusOutput } from './shared/outputs';
import { describeFailure, spotifyFor, textContent } from './shared/spotify';

type Status = SpotifyStatusOutput;
type Device = NonNullable<Status['devices']>[number];

function failure(message: string, code: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
    // Kept from the first release: clients may read these fields on errors.
    structuredContent: { ok: false, action: 'status', error: message, code } as Status,
  };
}

function slimDevices(
  devices: Array<{
    id: string | null;
    name: string;
    type: string;
    is_active: boolean;
    volume_percent?: number | null | undefined;
  }>,
): Device[] {
  return devices.map((device) => ({
    id: device.id ?? null,
    name: String(device.name ?? ''),
    type: String(device.type ?? ''),
    is_active: !!device.is_active,
    volume_percent: device.volume_percent ?? null,
  }));
}

export const playerStatus = defineTool(
  'player_status',
  {
    title: 'Player Status',
    description:
      'Read the current player state, devices, queue, and current track. Optional include[] selects any of: player, devices, queue, current_track. Use this to learn device_id before control.',
    inputSchema: SpotifyStatusInputSchema,
    outputSchema: SpotifyStatusOutput,
    annotations: { title: 'Player Status', readOnlyHint: true, openWorldHint: true },
  },
  async (args, ctx, deps) => {
    try {
      const client = spotifyFor(ctx, deps);
      if (!client) return failure('Missing user token. Please authenticate.', 'unauthorized');

      const wanted = new Set(args.include ?? ['player', 'devices', 'current_track']);
      const output: Status = {};
      const [player, devices, queue, current] = await Promise.all([
        wanted.has('player') || wanted.has('current_track') ? getPlayerState(client) : undefined,
        wanted.has('devices') ? listDevices(client) : undefined,
        wanted.has('queue') ? getQueue(client) : undefined,
        wanted.has('current_track') ? getCurrentlyPlaying(client) : undefined,
      ]);

      if (player) {
        output.player = {
          is_playing: !!player.is_playing,
          shuffle_state: player.shuffle_state,
          repeat_state: player.repeat_state,
          progress_ms: player.progress_ms,
          timestamp: player.timestamp,
          device_id: player.device?.id ?? undefined,
          context_uri: player.context?.uri ?? null,
        };
      }
      if (devices) {
        output.devices = slimDevices(devices.devices);
        output.devicesById = Object.fromEntries(
          output.devices.filter((d) => d.id).map((d) => [d.id as string, d]),
        );
      }
      if (queue) {
        output.queue = {
          current_id: queue.currently_playing?.id ?? null,
          next_ids: Array.isArray(queue.queue)
            ? (queue.queue.map((item) => item?.id).filter(Boolean) as string[])
            : [],
        };
      }
      if (wanted.has('current_track')) {
        const track = current?.item;
        output.current_track = track
          ? {
              type: 'track',
              id: String(track.id),
              uri: String(track.uri),
              name: String(track.name),
              artists: Array.isArray(track.artists)
                ? (track.artists.map((a) => a.name).filter(Boolean) as string[])
                : [],
              album: track.album?.name ?? undefined,
              duration_ms: track.duration_ms ?? undefined,
            }
          : null;
        if (typeof current?.is_playing === 'boolean') {
          output.player = {
            ...(output.player ?? {}),
            is_playing:
              typeof output.player?.is_playing === 'boolean'
                ? output.player.is_playing
                : current.is_playing,
          };
        }
      }

      // Name the active device even when the caller didn't ask for devices.
      const devicesRequested = wanted.has('devices');
      const noDevices = devicesRequested && (output.devices ?? []).length === 0;
      let activeDeviceName = output.devices?.find((d) => d.id === output.player?.device_id)?.name;
      if (!activeDeviceName && output.player?.device_id && !devicesRequested) {
        try {
          output.devices = slimDevices((await listDevices(client)).devices);
          output.devicesById = Object.fromEntries(
            output.devices.filter((d) => d.id).map((d) => [d.id as string, d]),
          );
          activeDeviceName = output.devices.find((d) => d.id === output.player?.device_id)?.name;
        } catch {
          // The status is still useful without the device name.
        }
      }

      const message = statusMessage(output, {
        deviceLabel: activeDeviceName || undefined,
        devicesRequested,
        noDevices,
        playerRequested: wanted.has('player') || wanted.has('current_track'),
      });
      const structured = { ...output, _msg: message };
      return { content: textContent(deps, message, structured), structuredContent: structured };
    } catch (error) {
      deps.logger.warning('Spotify request failed', { tool: 'player_status', error });
      const { message, code } = describeFailure(error);
      return failure(message, code);
    }
  },
);

/** The sentence the model reads: what is playing where, or what to do next. */
function statusMessage(
  output: Status,
  options: {
    deviceLabel: string | undefined;
    devicesRequested: boolean;
    noDevices: boolean;
    playerRequested: boolean;
  },
): string {
  const { deviceLabel, devicesRequested, noDevices, playerRequested } = options;
  const lastTrackNote = output.current_track?.name
    ? ` Last track was '${output.current_track.name}'.`
    : '';
  const isPlaying =
    typeof output.player?.is_playing === 'boolean' ? output.player.is_playing : undefined;
  const deviceList =
    (output.devices ?? []).length > 0
      ? `\n\nAvailable devices (use device_id for control):\n${(output.devices ?? [])
          .map(
            (d) =>
              `• ${d.name} (${d.type})${d.is_active ? ' [ACTIVE]' : ''} → device_id: "${d.id}"`,
          )
          .join('\n')}`
      : '';
  const contextBit = output.player?.context_uri ? ` Context: ${output.player.context_uri}.` : '';

  if (isPlaying === true) {
    const deviceBit = deviceLabel
      ? ` on '${deviceLabel}' (device_id: "${output.player?.device_id}")`
      : output.player?.device_id
        ? ` (device_id: "${output.player.device_id}")`
        : '';
    const trackBit = output.current_track?.name ? `'${output.current_track.name}'` : 'Content';
    return `${trackBit} is playing${deviceBit}.${contextBit}${deviceList}`.trim();
  }
  if (isPlaying === false) {
    if (devicesRequested) {
      return noDevices
        ? `No devices available.${lastTrackNote} Ask the user to open Spotify on any device, then try transfer or play again.`
        : `No active playback.${lastTrackNote} You can transfer to an available device and play.${deviceList}`;
    }
    return `No active playback.${lastTrackNote} To check devices, call player_status including "devices".`;
  }
  // The player was asked for, but Spotify isn't active anywhere.
  if (playerRequested && output.player === undefined) {
    if (devicesRequested) {
      return noDevices
        ? `Nothing playing right now, or Spotify isn't active. No devices found. Ask the user to open Spotify on a device first.`
        : `Nothing playing right now, or Spotify isn't active.${lastTrackNote} Pick a device and use transfer/play to start playback.${deviceList}`;
    }
    return `Nothing playing right now, or Spotify isn't active.${lastTrackNote} Include 'devices' to see available targets, or ask the user to open Spotify.`;
  }
  return output.current_track?.name
    ? `Playback status unknown. '${output.current_track.name}' is the current item.${contextBit} Include 'player' to confirm is_playing and 'devices' to list targets.${deviceList}`
    : `Playback status unknown.${contextBit} Include 'player' to confirm is_playing and 'devices' to list targets.${deviceList}`;
}
