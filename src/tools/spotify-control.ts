import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { defineTool } from '../platform/primitives';
import { errorCodeOf, type SpotifyErrorCode, withoutCode } from '../services/spotify';
import * as player from '../services/spotify-player';
import { type SpotifyControlInput, SpotifyControlInputSchema } from './shared/inputs';
import { SpotifyControlBatchOutput } from './shared/outputs';
import { verifyPlayback } from './shared/playback';
import { spotifyFor, textContent } from './shared/spotify';

type Operation = SpotifyControlInput['operations'][number];
type Result = SpotifyControlBatchOutput['results'][number];
/** The state that confirmed a play or transfer stays internal: the result schema is fixed. */
type OperationResult = Result & { playbackState?: player.PlayerState | undefined };

const PLAYBACK_ACTIONS = ['play', 'pause', 'next', 'previous', 'seek', 'transfer'];

function batchError(message: string, code?: SpotifyErrorCode) {
  const structured: SpotifyControlBatchOutput = {
    _msg: message,
    results: [{ index: 0, action: 'global', ok: false, error: message, code }],
    summary: { ok: 0, failed: 1 },
  };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

export const spotifyControl = defineTool(
  'spotify_control',
  {
    title: 'Control Spotify Playback',
    description:
      "Control Spotify playback: play, pause, next/previous, seek, shuffle, repeat, volume, transfer, and queue. Accepts a batch of operations and returns per-operation results. Optional parallel=true runs operations concurrently.\n\nUsage notes:\n- To play a specific track from a playlist, set 'context_uri' to the playlist URI (e.g., 'spotify:playlist:...') and set 'offset' to either { position: <zero-based index> } or { uri: 'spotify:track:...' }.\n- Do not provide 'uris' together with 'context_uri' in the same play operation.\n- Use the 'player_status' tool first to get a 'device_id' to target. For Mac playback choose the desktop Computer device, not Web Player (Firefox). An explicit ID is always respected; when omitted, an active desktop Computer is preferred, otherwise the active device is used.\n- Play/transfer verify playback and target device with up to five state checks; an accepted but unconfirmed command returns ok=false with recovery guidance. Use 'player_status' before retrying.\n- Use parallel=false for dependent playback operations (especially transfer then play); conflicting parallel playback batches are rejected.",
    inputSchema: SpotifyControlInputSchema,
    outputSchema: SpotifyControlBatchOutput,
    annotations: { title: 'Control Spotify Playback', readOnlyHint: false, openWorldHint: true },
  },
  async (args, ctx, deps) => {
    try {
      const client = spotifyFor(ctx, deps);
      if (!client) return batchError('Not signed in. Please authenticate.', 'unauthorized');

      // Spotify doesn't order concurrent playback commands, so a play or transfer could not be
      // verified before the next command changes the state again.
      if (
        args.parallel &&
        args.operations.some((op) => ['play', 'transfer'].includes(op.action)) &&
        args.operations.filter((op) => PLAYBACK_ACTIONS.includes(op.action)).length > 1
      ) {
        return batchError(
          'Conflicting playback operations cannot run in parallel: Spotify does not guarantee their order. Retry with parallel=false so play/transfer can be verified before the next operation.',
          'bad_response',
        );
      }

      const wait = deps.spotify.wait;
      const run = (operation: Operation, index: number) => execute(client, operation, index, wait);
      const outcomes: OperationResult[] = [];
      if (args.parallel) {
        outcomes.push(...(await Promise.all(args.operations.map(run))));
      } else {
        for (const [index, operation] of args.operations.entries()) {
          outcomes.push(await run(operation, index));
        }
      }

      const results = outcomes.map(({ playbackState: _state, ...result }) => result);
      const okActions = results.filter((r) => r.ok).map((r) => r.action);
      const failed = results.filter((r) => !r.ok);
      let summary =
        okActions.length > 0 ? `Successful: ${okActions.join(', ')}.` : `No successful operations.`;
      if (failed.length > 0) {
        summary += ` Failed (${failed.length}): ${failed.map((r) => r.action).join(', ')}.`;
        const details = failed
          .map((r) =>
            [r.action, r.code && `[${r.code}]`, r.error, r.note].filter(Boolean).join(' — '),
          )
          .filter((text) => text.trim().length > 0);
        if (details.length > 0) summary += ` Details: ${details.join(' | ')}`;
      }

      // A final snapshot of the batch, not a verification of earlier operations: a later pause
      // or next may replace what they observed on purpose. After a failure the results already
      // carry what was observed; don't read again after a 429 or 403.
      if (failed.length === 0) {
        try {
          const lastPlayback = outcomes.filter((r) => PLAYBACK_ACTIONS.includes(r.action)).at(-1);
          // The observation that confirmed the last play or transfer, not a second, possibly
          // different snapshot.
          const state = lastPlayback?.playbackState ?? (await player.getPlayerState(client));
          const devices = await player.listDevices(client).catch(() => null);
          const device = devices?.devices.find((d) => d.id === state?.device?.id);
          const deviceLabel = device ? ` on '${device.name}'` : '';
          const bits: string[] = [];
          if (typeof state?.is_playing === 'boolean') {
            bits.push(
              state.is_playing ? `Now playing${deviceLabel}.` : `Playback is paused${deviceLabel}.`,
            );
          } else {
            bits.push('Playback status unavailable.');
          }
          if (state?.item?.name) bits.push(`Current track: '${state.item.name}'.`);
          if (okActions.includes('volume') && typeof device?.volume_percent === 'number') {
            bits.push(`Volume: ${device.volume_percent}%.`);
          }
          summary += ` Final status: ${bits.join(' ')}`;
        } catch {
          summary += ' Final status unavailable; use player_status to check again.';
        }
      }

      const structured: SpotifyControlBatchOutput = {
        _msg: summary,
        results,
        summary: { ok: okActions.length, failed: failed.length },
      };
      return {
        isError: failed.length > 0,
        content: textContent(deps, summary, structured),
        structuredContent: structured,
      };
    } catch (error) {
      deps.logger.warning('Spotify request failed', { tool: 'spotify_control', error });
      return batchError(`Control request failed: ${(error as Error).message}`);
    }
  },
);

/** One operation. Spotify failures become a failed result; they never end the batch. */
async function execute(
  client: SpotifyApi,
  operation: Operation,
  index: number,
  wait: (ms: number) => Promise<void>,
): Promise<OperationResult> {
  const missing = (field: string) => ({
    index,
    action: operation.action,
    ok: false,
    error: `${field} is required for ${operation.action}`,
  });
  try {
    switch (operation.action) {
      case 'play': {
        if (operation.context_uri && operation.uris && operation.uris.length > 0) {
          return {
            index,
            action: 'play',
            ok: false,
            error: "Provide either 'context_uri' (optionally with 'offset') or 'uris', not both.",
          };
        }
        const offset = normalizeOffset(operation.offset);
        if (offset.error) return { index, action: 'play', ok: false, error: offset.error };
        // Web Players may report type=Computer too. Without an explicit target, prefer an
        // active desktop app; an explicit target is always respected.
        let deviceId = operation.device_id;
        if (!deviceId) {
          const active = (await player.listDevices(client)).devices.filter(
            (device) => device.is_active && device.id,
          );
          deviceId =
            active.find((device) => device.type === 'Computer' && !/web player/i.test(device.name))
              ?.id ??
            active[0]?.id ??
            undefined;
        }
        await player.play(client, {
          device_id: deviceId,
          context_uri: operation.context_uri,
          uris: operation.uris,
          offset: offset.value,
          position_ms: operation.position_ms,
        });
        return {
          index,
          action: 'play',
          device_id: deviceId,
          ...(await verifyPlayback(client, { ...operation, device_id: deviceId }, wait)),
        };
      }
      case 'pause':
        await player.pause(client, operation.device_id);
        return { index, action: 'pause', ok: true };
      case 'next':
        await player.next(client, operation.device_id);
        return { index, action: 'next', ok: true };
      case 'previous':
        await player.previous(client, operation.device_id);
        return { index, action: 'previous', ok: true };
      case 'seek':
        if (typeof operation.position_ms !== 'number') return missing('position_ms');
        await player.seek(client, operation.position_ms, operation.device_id);
        return { index, action: 'seek', ok: true };
      case 'shuffle':
        if (typeof operation.shuffle !== 'boolean') return missing('shuffle');
        await player.shuffle(client, operation.shuffle, operation.device_id);
        return { index, action: 'shuffle', ok: true };
      case 'repeat':
        if (!operation.repeat) return missing('repeat');
        await player.repeat(client, operation.repeat, operation.device_id);
        return { index, action: 'repeat', ok: true };
      case 'volume':
        if (typeof operation.volume_percent !== 'number') return missing('volume_percent');
        await player.volume(client, operation.volume_percent, operation.device_id);
        return { index, action: 'volume', ok: true };
      case 'transfer': {
        if (!operation.device_id) return missing('device_id');
        let from: { id: string | undefined; name: string | undefined } | undefined;
        try {
          const active = (await player.listDevices(client)).devices.find((d) => d?.is_active);
          if (active) from = { id: active.id ?? undefined, name: active.name ?? undefined };
        } catch {}
        await player.transfer(client, operation.device_id, operation.transfer_play ?? false);
        const verification = await verifyPlayback(client, operation, wait);
        let toName: string | undefined;
        try {
          const target = (await player.listDevices(client)).devices.find(
            (d) => d?.id === operation.device_id,
          );
          toName = target?.name ?? undefined;
        } catch {}
        return {
          index,
          action: 'transfer',
          ...verification,
          device_id: operation.device_id,
          device_name: toName,
          from_device_id: from?.id,
          from_device_name: from?.name,
        };
      }
      case 'queue':
        if (!operation.queue_uri) return missing('queue_uri');
        await player.queue(client, operation.queue_uri, operation.device_id);
        return { index, action: 'queue', ok: true };
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
    const code = errorCodeOf(message);
    return {
      index,
      action: operation.action,
      ok: false,
      error: withoutCode(message),
      code,
      ...(noteFor(code, message) && { note: noteFor(code, message) }),
    };
  }
}

/** What the model should do after a failed command. */
function noteFor(code: SpotifyErrorCode | undefined, message: string): string | undefined {
  if (code === 'unauthorized') return 'Reconnect Spotify and retry.';
  if (code === 'forbidden') {
    return 'Check the Spotify error details: playback requires Premium, user-modify-playback-state permission, and an unrestricted Connect device. Reconnect Spotify if permissions are missing; try the track manually to check availability.';
  }
  if (code === 'rate_limited') return 'Wait for Spotify’s rate limit to clear before retrying.';
  if (/no\s+active\s+device/i.test(message)) {
    return 'No active device. Ask the user to open Spotify on any device and retry, or use transfer to a listed device.';
  }
  return undefined;
}

function normalizeOffset(offset: Operation['offset']): {
  value?: { position?: number; uri?: string };
  error?: string;
} {
  if (!offset) return {};
  const uri = typeof offset.uri === 'string' ? offset.uri.trim() : undefined;
  const hasPosition = typeof offset.position === 'number';
  const hasUri = !!uri;
  if (!hasPosition && !hasUri) return {};
  if (hasPosition && hasUri) {
    return { error: "Illegal offset: use either 'offset.position' or 'offset.uri', not both." };
  }
  return hasUri
    ? { value: { uri: uri as string } }
    : { value: { position: offset.position as number } };
}
