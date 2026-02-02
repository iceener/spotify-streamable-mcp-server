/**
 * Player Status Tool - Get current Spotify player state, devices, and queue.
 */

import type { z } from 'zod';
import { config } from '../../config/env.js';
import { toolsMetadata } from '../../config/metadata.js';
import { SpotifyStatusInputSchema } from '../../schemas/inputs.js';
import { SpotifyStatusOutput } from '../../schemas/outputs.js';
import {
  getCurrentlyPlaying,
  getPlayerState,
  getQueue,
  listDevices,
} from '../../services/spotify/player.js';
import { getSpotifyUserClient } from '../../services/spotify/sdk.js';
import { sharedLogger as logger } from '../utils/logger.js';
import { defineTool, type ToolContext, type ToolResult } from './types.js';

type ErrorCode = 'unauthorized' | 'forbidden' | 'rate_limited' | 'bad_response';

function errorResult(message: string, code?: ErrorCode): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: { ok: false, action: 'status', error: message, code },
  };
}

export const playerStatusTool = defineTool({
  name: toolsMetadata.player_status.name,
  title: toolsMetadata.player_status.title,
  description: toolsMetadata.player_status.description,
  inputSchema: SpotifyStatusInputSchema,
  outputSchema: SpotifyStatusOutput.shape,
  annotations: {
    title: toolsMetadata.player_status.title,
    readOnlyHint: true,
    openWorldHint: true,
  },

  handler: async (args, context: ToolContext): Promise<ToolResult> => {
    try {
      const client = await getSpotifyUserClient(context);
      if (!client) {
        logger.info('player_status', {
          message: 'Missing user token',
          sessionId: context.sessionId,
        });
        return errorResult('Missing user token. Please authenticate.', 'unauthorized');
      }

      const wantedData = new Set(
        args.include ?? ['player', 'devices', 'current_track'],
      );

      const requests: Array<Promise<unknown>> = [];
      const requestKeys: string[] = [];

      if (wantedData.has('player')) {
        requestKeys.push('player');
        requests.push(getPlayerState(client));
      }
      if (wantedData.has('devices')) {
        requestKeys.push('devices');
        requests.push(listDevices(client));
      }
      if (wantedData.has('queue')) {
        requestKeys.push('queue');
        requests.push(getQueue(client));
      }
      if (wantedData.has('current_track')) {
        requestKeys.push('current_track');
        requests.push(getCurrentlyPlaying(client));
      }
      if (wantedData.has('current_track') && !requestKeys.includes('player')) {
        requestKeys.push('player');
        requests.push(getPlayerState(client));
      }

      const results = await Promise.all(requests);

      const output: Partial<z.infer<typeof SpotifyStatusOutput>> = {};

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
            devicesList.filter((d) => d.id).map((d) => [d.id as string, d]),
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
                ? (trackItem.artists.map((a) => a.name).filter(Boolean) as string[])
                : [],
              album: trackItem.album?.name,
              duration_ms: trackItem.duration_ms,
            };
          } else {
            output.current_track = null;
          }

          if (typeof currentValue?.is_playing === 'boolean') {
            output.player = {
              ...(output.player ?? {}),
              is_playing:
                typeof output.player?.is_playing === 'boolean'
                  ? output.player?.is_playing
                  : currentValue.is_playing,
            };
          }
        }
      }

      // Derive device name and build status message
      const devicesRequested = wantedData.has('devices');
      const noDevices = devicesRequested && (output.devices ?? []).length === 0;
      let activeDeviceName = output.devices?.find(
        (d) => d.id === output.player?.device_id,
      )?.name;

      if (!activeDeviceName && output.player?.device_id && !devicesRequested) {
        try {
          const dv = await listDevices(client);
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
            devicesList.filter((d) => d.id).map((d) => [d.id as string, d]),
          );
          activeDeviceName = devicesList.find(
            (d) => d.id === output.player?.device_id,
          )?.name;
        } catch {
          // Ignore errors fetching devices
        }
      }

      const deviceLabel = activeDeviceName || undefined;
      const lastTrackNote = output.current_track?.name
        ? ` Last track was '${output.current_track.name}'.`
        : '';
      
      // Track what was actually requested vs what returned data
      const playerWasRequested = wantedData.has('player') || wantedData.has('current_track');
      const playerReturnedData = output.player !== undefined;
      
      const derivedIsPlaying =
        typeof output.player?.is_playing === 'boolean'
          ? output.player?.is_playing
          : undefined;

      // Build device list for the message (showing ID prominently)
      const deviceListMsg =
        (output.devices ?? []).length > 0
          ? `\n\nAvailable devices (use device_id for control):\n${(
              output.devices ?? []
            )
              .map(
                (d) =>
                  `• ${d.name} (${d.type})${d.is_active ? ' [ACTIVE]' : ''} → device_id: "${d.id}"`,
              )
              .join('\n')}`
          : '';

      const statusMessage = (() => {
        const deviceBit = deviceLabel
          ? ` on '${deviceLabel}' (device_id: "${output.player?.device_id}")`
          : output.player?.device_id
            ? ` (device_id: "${output.player.device_id}")`
            : '';

        if (derivedIsPlaying === true) {
          const trackBit = output.current_track?.name
            ? `'${output.current_track.name}'`
            : 'Content';
          const contextBit = output.player?.context_uri
            ? ` Context: ${output.player.context_uri}.`
            : '';
          return `${trackBit} is playing${deviceBit}.${contextBit}${deviceListMsg}`.trim();
        }

        if (derivedIsPlaying === false) {
          if (devicesRequested) {
            return noDevices
              ? `No devices available.${lastTrackNote} Ask the user to open Spotify on any device, then try transfer or play again.`
              : `No active playback.${lastTrackNote} You can transfer to an available device and play.${deviceListMsg}`;
          }
          return `No active playback.${lastTrackNote} To check devices, call player_status including "devices".`;
        }

        // Player was requested but returned no data - Spotify isn't active anywhere
        if (playerWasRequested && !playerReturnedData) {
          if (devicesRequested) {
            return noDevices
              ? `Nothing playing right now, or Spotify isn't active. No devices found. Ask the user to open Spotify on a device first.`
              : `Nothing playing right now, or Spotify isn't active.${lastTrackNote} Pick a device and use transfer/play to start playback.${deviceListMsg}`;
          }
          return `Nothing playing right now, or Spotify isn't active.${lastTrackNote} Include 'devices' to see available targets, or ask the user to open Spotify.`;
        }

        // Player wasn't requested - suggest including it
        const contextBit = output.player?.context_uri
          ? ` Context: ${output.player.context_uri}.`
          : '';
        return output.current_track?.name
          ? `Playback status unknown. '${output.current_track.name}' is the current item.${contextBit} Include 'player' to confirm is_playing and 'devices' to list targets.${deviceListMsg}`
          : `Playback status unknown.${contextBit} Include 'player' to confirm is_playing and 'devices' to list targets.${deviceListMsg}`;
      })();

      const structured = {
        ...output,
        _msg: statusMessage,
      };

      const contentParts: Array<{ type: 'text'; text: string }> = [
        { type: 'text', text: statusMessage },
      ];

      if (config.SPOTIFY_INCLUDE_JSON_IN_CONTENT) {
        contentParts.push({ type: 'text', text: JSON.stringify(structured) });
      }

      return {
        content: contentParts,
        structuredContent: structured,
      };
    } catch (error) {
      const err = error as Error;
      logger.error('player_status', { message: 'Tool error', error: err.message });

      const codeMatch = err.message.match(/\[(\w+)\]$/);
      const code = codeMatch ? (codeMatch[1] as ErrorCode) : 'bad_response';

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
});
