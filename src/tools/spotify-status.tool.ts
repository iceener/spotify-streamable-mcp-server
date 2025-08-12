import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config/env.js';
import { toolsMetadata } from '../config/metadata.js';
import { getUserBearer } from '../core/auth.js';
import { getCurrentSessionId } from '../core/context.js';
import { createHttpClient } from '../core/http-client.js';
import {
  type SpotifyStatusInput,
  SpotifyStatusInputSchema,
} from '../schemas/inputs.js';
import { SpotifyStatusOutput } from '../schemas/outputs.js';
import {
  getCurrentlyPlaying,
  getPlayerState,
  getQueue,
  listDevices,
} from '../services/spotify/player.js';
import type { ErrorCode } from '../utils/http-result.js';
import { logger } from '../utils/logger.js';
import { apiBase } from '../utils/spotify.js';
import { validateDev } from '../utils/validate.js';

const http = createHttpClient({
  baseHeaders: {
    'Content-Type': 'application/json',
    'User-Agent': `mcp-spotify/${config.MCP_VERSION}`,
  },
  rateLimit: { rps: 5, burst: 10 },
  timeout: 15000,
  retries: 1,
});

export const spotifyStatusTool = {
  name: 'player_status',
  title: toolsMetadata.player_status.title,
  description: toolsMetadata.player_status.description,
  inputSchema: SpotifyStatusInputSchema.shape,

  handler: async (
    args: SpotifyStatusInput,
    signal?: AbortSignal,
  ): Promise<CallToolResult> => {
    try {
      // Input validation at boundary
      const parsed = SpotifyStatusInputSchema.parse(args);

      // Auth check
      const token = await getUserBearer();

      if (!token) {
        const sessionId = getCurrentSessionId();
        logger.info('spotify_status', {
          message: 'Missing user token',
          sessionId,
        });

        return errorResult('Missing user token. Please authenticate.', 'unauthorized');
      }

      const wantedData = new Set(
        parsed.include ?? ['player', 'devices', 'current_track'],
      );

      const headers = { Authorization: `Bearer ${token}` };
      const base = apiBase(config.SPOTIFY_API_URL);

      const requests: Array<Promise<unknown>> = [];
      const requestKeys: string[] = [];

      // Build parallel requests based on what data is wanted
      if (wantedData.has('player')) {
        requestKeys.push('player');
        requests.push(
          (async () => {
            return getPlayerState(http, base, headers, signal);
          })(),
        );
      }

      if (wantedData.has('devices')) {
        requestKeys.push('devices');
        requests.push(
          (async () => {
            return listDevices(http, base, headers, signal);
          })(),
        );
      }

      if (wantedData.has('queue')) {
        requestKeys.push('queue');
        requests.push(
          (async () => {
            return getQueue(http, base, headers, signal);
          })(),
        );
      }

      if (wantedData.has('current_track')) {
        requestKeys.push('current_track');
        requests.push(
          (async () => {
            return getCurrentlyPlaying(http, base, headers, signal);
          })(),
        );
      }

      // Ensure playback status is always available when asking for current_track
      // If the caller did not request 'player' but requested 'current_track',
      // add a lightweight player state request to derive is_playing/device.
      if (wantedData.has('current_track') && !requestKeys.includes('player')) {
        requestKeys.push('player');
        requests.push(
          (async () => {
            return getPlayerState(http, base, headers, signal);
          })(),
        );
      }

      // Execute all requests in parallel
      const results = await Promise.all(requests);

      // Build output object
      const output: Partial<SpotifyStatusOutput> = {};

      for (let index = 0; index < requestKeys.length; index++) {
        const key = requestKeys[index];
        const value = results[index];

        if (key === 'player' && value && typeof value === 'object') {
          const playerValue = value as {
            is_playing?: boolean;
            shuffle_state?: boolean;
            repeat_state?: 'off' | 'track' | 'context';
            progress_ms?: number;
            timestamp?: number;
            device?: { id?: string };
            context?: { uri?: string };
          };

          output.player = {
            is_playing: !!playerValue.is_playing,
            shuffle_state: playerValue.shuffle_state,
            repeat_state: playerValue.repeat_state,
            progress_ms: playerValue.progress_ms,
            timestamp: playerValue.timestamp,
            device_id: playerValue.device?.id ?? undefined,
            context_uri: playerValue.context?.uri ?? null,
          };
        }

        if (key === 'devices' && value) {
          const devicesValue = value as {
            devices?: Array<{
              id?: string | null;
              name?: string;
              type?: string;
              is_active?: boolean;
              volume_percent?: number | null;
            }>;
          };

          const devicesList = Array.isArray(devicesValue?.devices)
            ? devicesValue.devices.map((device) => ({
                id: device.id ?? null,
                name: String(device.name ?? ''),
                type: String(device.type ?? ''),
                is_active: !!device.is_active,
                volume_percent: device.volume_percent ?? null,
              }))
            : [];

          output.devices = devicesList;
          output.devicesById = Object.fromEntries(
            devicesList
              .filter((device) => device.id)
              .map((device) => [device.id as string, device]),
          );
        }

        if (key === 'queue' && value) {
          const queueValue = value as {
            currently_playing?: { id?: string | null };
            queue?: Array<{ id?: string | null }>;
          };

          output.queue = {
            current_id: queueValue.currently_playing?.id ?? null,
            next_ids: Array.isArray(queueValue.queue)
              ? (queueValue.queue.map((item) => item?.id).filter(Boolean) as string[])
              : [],
          };
        }

        if (key === 'current_track') {
          const currentValue = value as {
            item?: unknown;
            is_playing?: boolean;
          };
          const trackItem = currentValue?.item as
            | {
                id?: unknown;
                uri?: unknown;
                name?: unknown;
                artists?: Array<{ name?: string }>;
                album?: { name?: string };
                duration_ms?: number;
              }
            | undefined;

          if (trackItem) {
            output.current_track = {
              type: 'track',
              id: String(trackItem.id),
              uri: String(trackItem.uri),
              name: String(trackItem.name),
              artists: Array.isArray(trackItem.artists)
                ? (trackItem.artists
                    .map((artist) => artist.name)
                    .filter(Boolean) as string[])
                : [],
              album: trackItem.album?.name,
              duration_ms: trackItem.duration_ms,
            };
          } else {
            output.current_track = null;
          }

          // Fallback: if player state wasn't requested, derive is_playing from currently-playing
          if (typeof currentValue?.is_playing === 'boolean') {
            output.player = {
              ...(output.player ?? {}),
              is_playing:
                typeof output.player?.is_playing === 'boolean'
                  ? (output.player?.is_playing as boolean)
                  : currentValue.is_playing,
            };
          }
        }
      }

      // Build status message
      const devicesRequested = wantedData.has('devices');
      const noDevices = devicesRequested && (output.devices ?? []).length === 0;
      // Best-effort device name resolution if we only have device_id
      let activeDeviceName = output.devices?.find(
        (d) => d.id === output.player?.device_id,
      )?.name;
      if (!activeDeviceName && output.player?.device_id && !devicesRequested) {
        try {
          const dv = await listDevices(http, base, headers, signal);
          const devicesList = Array.isArray(dv?.devices)
            ? dv.devices.map((device) => ({
                id: device.id ?? null,
                name: String(device.name ?? ''),
                type: String(device.type ?? ''),
                is_active: !!device.is_active,
                volume_percent: device.volume_percent ?? null,
              }))
            : [];
          output.devices = devicesList;
          output.devicesById = Object.fromEntries(
            devicesList
              .filter((device) => device.id)
              .map((device) => [device.id as string, device]),
          );
          activeDeviceName = devicesList.find(
            (d) => d.id === output.player?.device_id,
          )?.name;
        } catch {
          // ignore, best-effort only
        }
      }
      const deviceLabel = activeDeviceName || undefined;
      const lastTrackNote = output.current_track?.name
        ? ` Last track was '${output.current_track.name}'.`
        : '';
      const derivedIsPlaying =
        typeof output.player?.is_playing === 'boolean'
          ? (output.player?.is_playing as boolean)
          : undefined;

      const statusMessage = (() => {
        const deviceBit = deviceLabel
          ? ` on device '${deviceLabel}'`
          : output.player?.device_id
            ? ` on device id ${output.player.device_id}`
            : '';
        if (derivedIsPlaying === true) {
          const trackBit = output.current_track?.name
            ? `'${output.current_track.name}'`
            : 'Content';
          const contextBit = output.player?.context_uri
            ? ` Context: ${output.player.context_uri}.`
            : '';
          return `${trackBit} is playing${deviceBit}.${contextBit}`.trim();
        }
        if (derivedIsPlaying === false) {
          if (devicesRequested) {
            return noDevices
              ? `No devices available.${lastTrackNote} Ask the user to open Spotify on any device, then try transfer or play again.`
              : `No active playback.${lastTrackNote} You can transfer to an available device and play.`;
          }
          return `No active playback.${lastTrackNote} To check devices, call player_status including "devices".`;
        }
        // Unknown
        const contextBit = output.player?.context_uri
          ? ` Context: ${output.player.context_uri}.`
          : '';
        return output.current_track?.name
          ? `Playback status unknown. '${output.current_track.name}' is the current item.${contextBit} Include 'player' to confirm is_playing and 'devices' to list targets.`
          : `Playback status unknown.${contextBit} Include 'player' to confirm is_playing and 'devices' to list targets.`;
      })();

      const structured = {
        ...(output as SpotifyStatusOutput),
        _msg: statusMessage,
      };

      const contentParts: Array<{ type: 'text'; text: string }> = [
        { type: 'text', text: statusMessage },
      ];
      if (config.SPOTIFY_MCP_INCLUDE_JSON_IN_CONTENT) {
        contentParts.push({ type: 'text', text: JSON.stringify(structured) });
      }

      return {
        content: contentParts,
        structuredContent: validateDev(SpotifyStatusOutput, structured),
      };
    } catch (error) {
      const err = error as Error;
      logger.error('spotify_status', { error: err.message });

      // Extract error code from error message if present
      const codeMatch = err.message.match(/\[(\w+)\]$/);
      const code = codeMatch ? (codeMatch[1] as ErrorCode) : 'bad_response';

      // Map error codes to user-friendly messages
      let userMessage = err.message.replace(/\s*\[\w+\]$/, '');

      if (code === 'unauthorized') {
        userMessage = 'Not authenticated. Please sign in to Spotify.';
      } else if (code === 'forbidden') {
        userMessage =
          'Access denied. You may need additional permissions or Spotify Premium.';
      } else if (code === 'rate_limited') {
        userMessage = 'Too many requests. Please wait a moment and try again.';
      }

      return errorResult(userMessage, code);
    }
  },
};

// Helper function for error responses

function errorResult(message: string, code?: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: {
      ok: false,
      action: 'status',
      error: message,
      code,
    },
  };
}
