/**
 * Spotify Control Tool - Control playback, volume, shuffle, repeat, queue, and transfer.
 */

import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { toolsMetadata } from '../../config/metadata.js';
import {
  type SpotifyControlInput,
  SpotifyControlInputSchema,
} from '../../schemas/inputs.js';
import { SpotifyControlBatchOutput } from '../../schemas/outputs.js';
import {
  next as apiNext,
  pause as apiPause,
  play as apiPlay,
  previous as apiPrevious,
  queueUri as apiQueue,
  repeat as apiRepeat,
  seek as apiSeek,
  shuffle as apiShuffle,
  transfer as apiTransfer,
  volume as apiVolume,
  getPlayerState,
  listDevices,
} from '../../services/spotify/player.js';
import { getSpotifyUserClient } from '../../services/spotify/sdk.js';

type ErrorCode = 'unauthorized' | 'forbidden' | 'rate_limited' | 'bad_response';

import { sharedLogger as logger } from '../utils/logger.js';
import { verifyPlayback } from './playback-verification.js';
import { defineTool, type ToolContext, type ToolResult } from './types.js';

function toolError(message: string, code?: ErrorCode): ToolResult {
  const failedResult: SpotifyControlBatchOutput['results'][number] = {
    index: 0,
    action: 'global',
    ok: false,
    error: message,
    code,
  };
  const structured: SpotifyControlBatchOutput = {
    _msg: message,
    results: [failedResult],
    summary: { ok: 0, failed: 1 },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

export const spotifyControlTool = defineTool({
  name: toolsMetadata.spotify_control.name,
  title: toolsMetadata.spotify_control.title,
  description: toolsMetadata.spotify_control.description,
  inputSchema: SpotifyControlInputSchema,
  outputSchema: SpotifyControlBatchOutput,
  annotations: {
    title: toolsMetadata.spotify_control.title,
    readOnlyHint: false,
    openWorldHint: true,
  },

  handler: async (args, context: ToolContext): Promise<ToolResult> => {
    try {
      const client = await getSpotifyUserClient(context);
      if (!client) {
        return toolError('Not signed in. Please authenticate.', 'unauthorized');
      }

      const playbackActions = ['play', 'pause', 'next', 'previous', 'seek', 'transfer'];
      if (
        args.parallel &&
        args.operations.some((op) => ['play', 'transfer'].includes(op.action)) &&
        args.operations.filter((op) => playbackActions.includes(op.action)).length > 1
      ) {
        return toolError(
          'Conflicting playback operations cannot run in parallel: Spotify does not guarantee their order. Retry with parallel=false so play/transfer can be verified before the next operation.',
          'bad_response',
        );
      }

      const runOp = (
        operation: SpotifyControlInput['operations'][number],
        index: number,
      ) => executeOperation({ operation, index, client });

      const results = args.parallel
        ? await Promise.all(args.operations.map(runOp))
        : await (async () => {
            const acc: Awaited<ReturnType<typeof executeOperation>>[] = [];
            for (let i = 0; i < args.operations.length; i++) {
              const op = args.operations[i];
              if (op) {
                acc.push(await runOp(op, i));
              }
            }
            return acc;
          })();

      const okActions = results.filter((r) => r.ok).map((r) => r.action);
      const failed = results.filter((r) => !r.ok);
      const failedCount = failed.length;
      const okCount = okActions.length;

      let summary =
        okCount > 0
          ? `Successful: ${okActions.join(', ')}.`
          : `No successful operations.`;
      if (failedCount > 0) {
        const failedActions = failed.map((r) => r.action);
        summary += ` Failed (${failedCount}): ${failedActions.join(', ')}.`;
        const failureDetails = failed
          .map((result) => {
            const detailParts: string[] = [result.action];
            if (result.code) {
              detailParts.push(`[${result.code}]`);
            }
            if (result.error) {
              detailParts.push(result.error);
            }
            if (result.note) {
              detailParts.push(result.note);
            }
            return detailParts.join(' — ');
          })
          .filter((text) => text.trim().length > 0);
        if (failureDetails.length > 0) {
          summary += ` Details: ${failureDetails.join(' | ')}`;
        }
      }

      // This is a final batch snapshot, not verification of earlier operations
      // (a later pause/next/play may intentionally replace their observed state).
      try {
        const player = await getPlayerState(client);
        const devices = await listDevices(client).catch(() => null);
        const device = devices?.devices.find((d) => d.id === player?.device?.id);
        const deviceLabel = device ? ` on '${device.name}'` : '';
        const statusBits: string[] = [];
        if (typeof player?.is_playing === 'boolean') {
          statusBits.push(
            player.is_playing
              ? `Now playing${deviceLabel}.`
              : `Playback is paused${deviceLabel}.`,
          );
        } else {
          statusBits.push('Playback status unavailable.');
        }
        if (player?.item?.name) {
          statusBits.push(`Current track: '${player.item.name}'.`);
        }
        if (
          okActions.includes('volume') &&
          typeof device?.volume_percent === 'number'
        ) {
          statusBits.push(`Volume: ${device.volume_percent}%.`);
        }
        summary += ` Final status: ${statusBits.join(' ')}`;
      } catch {
        summary += ' Final status unavailable; use player_status to check again.';
      }

      const structured: SpotifyControlBatchOutput = {
        _msg: summary,
        results,
        summary: { ok: okCount, failed: failedCount },
      };
      const contentParts: Array<{ type: 'text'; text: string }> = [
        { type: 'text', text: summary },
      ];
      if (context.spotify.includeJsonInContent) {
        contentParts.push({ type: 'text', text: JSON.stringify(structured) });
      }
      return {
        isError: failedCount > 0,
        content: contentParts,
        structuredContent: structured,
      };
    } catch (error) {
      logger.error('spotify_control', {
        message: 'Control error',
        error: (error as Error).message,
      });
      return toolError(`Control request failed: ${(error as Error).message}`);
    }
  },
});

type OperationDeps = {
  operation: SpotifyControlInput['operations'][number];
  index: number;
  client: SpotifyApi;
};

async function executeOperation({
  operation,
  index,
  client,
}: OperationDeps): Promise<SpotifyControlBatchOutput['results'][number]> {
  try {
    switch (operation.action) {
      case 'play': {
        if (operation.context_uri && operation.uris && operation.uris.length > 0) {
          return {
            index,
            action: 'play',
            ok: false,
            error:
              "Provide either 'context_uri' (optionally with 'offset') or 'uris', not both.",
          };
        }
        const normalizedOffset = normalizeOffset(operation.offset);
        if (normalizedOffset.error) {
          return {
            index,
            action: 'play',
            ok: false,
            error: normalizedOffset.error,
          };
        }
        await apiPlay(client, {
          device_id: operation.device_id,
          context_uri: operation.context_uri,
          uris: operation.uris,
          offset: normalizedOffset.value,
          position_ms: operation.position_ms,
        });
        return { index, action: 'play', ...(await verifyPlayback(client, operation)) };
      }
      case 'pause': {
        await apiPause(client, { device_id: operation.device_id });
        return { index, action: 'pause', ok: true };
      }
      case 'next': {
        await apiNext(client, { device_id: operation.device_id });
        return { index, action: 'next', ok: true };
      }
      case 'previous': {
        await apiPrevious(client, { device_id: operation.device_id });
        return { index, action: 'previous', ok: true };
      }
      case 'seek': {
        if (typeof operation.position_ms !== 'number') {
          return {
            index,
            action: 'seek',
            ok: false,
            error: 'position_ms is required for seek',
          };
        }
        await apiSeek(client, operation.position_ms, {
          device_id: operation.device_id,
        });
        return { index, action: 'seek', ok: true };
      }
      case 'shuffle': {
        if (typeof operation.shuffle !== 'boolean') {
          return {
            index,
            action: 'shuffle',
            ok: false,
            error: 'shuffle is required for shuffle',
          };
        }
        await apiShuffle(client, operation.shuffle, {
          device_id: operation.device_id,
        });
        return { index, action: 'shuffle', ok: true };
      }
      case 'repeat': {
        if (!operation.repeat) {
          return {
            index,
            action: 'repeat',
            ok: false,
            error: 'repeat is required for repeat',
          };
        }
        await apiRepeat(client, operation.repeat, {
          device_id: operation.device_id,
        });
        return { index, action: 'repeat', ok: true };
      }
      case 'volume': {
        if (typeof operation.volume_percent !== 'number') {
          return {
            index,
            action: 'volume',
            ok: false,
            error: 'volume_percent is required for volume',
          };
        }
        await apiVolume(client, operation.volume_percent, {
          device_id: operation.device_id,
        });
        return { index, action: 'volume', ok: true };
      }
      case 'transfer': {
        if (!operation.device_id) {
          return {
            index,
            action: 'transfer',
            ok: false,
            error: 'device_id is required for transfer',
          };
        }
        let fromDeviceId: string | undefined;
        let fromDeviceName: string | undefined;
        try {
          const devices = await listDevices(client);
          const active = devices?.devices?.find((d) => d?.is_active);
          if (active) {
            fromDeviceId = active.id ?? undefined;
            fromDeviceName = (active.name ?? undefined) as string | undefined;
          }
        } catch {}
        await apiTransfer(
          client,
          operation.device_id,
          operation.transfer_play ?? false,
        );
        const verification = await verifyPlayback(client, operation);
        let toDeviceName: string | undefined;
        try {
          const devices = await listDevices(client);
          const target = devices?.devices?.find((d) => d?.id === operation.device_id);
          if (target) {
            toDeviceName = (target.name ?? undefined) as string | undefined;
          }
        } catch {}
        return {
          index,
          action: 'transfer',
          ...verification,
          device_id: operation.device_id,
          device_name: toDeviceName,
          from_device_id: fromDeviceId,
          from_device_name: fromDeviceName,
        };
      }
      case 'queue': {
        if (!operation.queue_uri) {
          return {
            index,
            action: 'queue',
            ok: false,
            error: 'queue_uri is required for queue',
          };
        }
        await apiQueue(client, operation.queue_uri, {
          device_id: operation.device_id,
        });
        return { index, action: 'queue', ok: true };
      }
      default:
        return {
          index,
          action: String((operation as { action: unknown }).action),
          ok: false,
          error: 'Unknown action',
        };
    }
  } catch (error) {
    const message = (error as Error).message;
    const codeMatch = message.match(
      /\[(unauthorized|forbidden|rate_limited|bad_response)\]$/,
    );
    const code = (codeMatch?.[1] as ErrorCode | undefined) ?? undefined;
    const result = {
      index,
      action: operation.action,
      ok: false,
      error: message.replace(/\s*\[[^\]]+\]$/, ''),
      code,
    };
    if (code === 'unauthorized') {
      (result as { note?: string }).note = 'Reconnect Spotify and retry.';
    } else if (code === 'forbidden') {
      (result as { note?: string }).note =
        'Check the Spotify error details: playback requires Premium, user-modify-playback-state permission, and an unrestricted Connect device. Reconnect Spotify if permissions are missing; try the track manually to check availability.';
    } else if (code === 'rate_limited') {
      (result as { note?: string }).note =
        'Wait for Spotify’s rate limit to clear before retrying.';
    } else if (/no\s+active\s+device/i.test(message)) {
      (result as { note?: string }).note =
        'No active device. Ask the user to open Spotify on any device and retry, or use transfer to a listed device.';
    }
    return result as SpotifyControlBatchOutput['results'][number];
  }
}

function normalizeOffset(
  offset?: SpotifyControlInput['operations'][number]['offset'],
): { value?: { position?: number; uri?: string }; error?: string } {
  if (!offset) {
    return { value: undefined };
  }

  const hasPosition = typeof offset.position === 'number';
  const trimmedUri = typeof offset.uri === 'string' ? offset.uri.trim() : undefined;
  const hasUri = typeof trimmedUri === 'string' && trimmedUri.length > 0;

  if (!hasPosition && !hasUri) {
    return { value: undefined };
  }

  if (hasPosition && hasUri) {
    return {
      error: "Illegal offset: use either 'offset.position' or 'offset.uri', not both.",
    };
  }

  if (hasUri) {
    return { value: { uri: trimmedUri } };
  }

  return { value: { position: offset.position } };
}
