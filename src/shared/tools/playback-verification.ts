import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import type { SpotifyControlInput } from '../../schemas/inputs.js';
import type { SpotifyControlBatchOutput } from '../../schemas/outputs.js';
import { getPlayerState } from '../../services/spotify/player.js';

type Operation = SpotifyControlInput['operations'][number];
type Verification = Pick<
  SpotifyControlBatchOutput['results'][number],
  'ok' | 'code' | 'error' | 'note'
>;

const recovery =
  'Ask the user to open Spotify on the target device, confirm it uses the same Premium account, and play the requested track there once. Then refresh device IDs with player_status and retry. If that track cannot play manually, check its availability/account restrictions; if no tracks play, restart Spotify or choose another Connect device. Do not keep retrying play blindly.';

/** A successful PUT acknowledges the command, not the observed Connect state. */
export async function verifyPlayback(
  client: SpotifyApi,
  operation: Operation,
  wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 1000)),
): Promise<Verification> {
  const needsPlayback = operation.action === 'play' || operation.transfer_play === true;
  const expectedTrack =
    operation.action === 'play'
      ? operation.offset?.uri?.trim() ||
        operation.uris?.[operation.offset?.position ?? 0]
      : undefined;
  const expectedContext =
    operation.action === 'play' ? operation.context_uri : undefined;
  let observation = 'No playback state returned.';

  // Read immediately, then allow four seconds for Spotify Connect to settle.
  // Never replay the write: retries here are read-only.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await wait();
    let state: Awaited<ReturnType<typeof getPlayerState>>;
    try {
      state = await getPlayerState(client);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.match(
        /\[(unauthorized|forbidden|rate_limited|bad_response)\]$/,
      )?.[1] as Verification['code'];
      return {
        ok: false,
        code: code ?? 'bad_response',
        error: `Spotify accepted ${operation.action}, but its outcome was not confirmed: playback-state read failed: ${message}`,
        note:
          code === 'unauthorized' || code === 'forbidden'
            ? 'Reconnect Spotify with user-read-playback-state and user-modify-playback-state permissions on the same Premium account, then check player_status before retrying.'
            : code === 'rate_limited'
              ? 'Wait for Spotify’s rate limit to clear, then check player_status before sending another playback command.'
              : 'Check player_status before retrying; the command may have taken effect even though verification failed.',
      };
    }

    const issues: string[] = [];
    if (!state) {
      issues.push('No playback state returned');
    } else {
      if (operation.device_id && state.device?.id !== operation.device_id) {
        issues.push(
          `Target device not confirmed (expected: ${operation.device_id}; observed: ${state.device?.id ?? 'none'})`,
        );
      }
      if (needsPlayback) {
        if (state.is_playing !== true) {
          issues.push(
            state.is_playing === false
              ? 'Playback is paused'
              : 'Playback state unknown',
          );
        }
        if (!state.item?.uri) issues.push('No current track');
        if (
          expectedTrack &&
          state.item?.uri !== expectedTrack &&
          state.item?.linked_from?.uri !== expectedTrack
        ) {
          issues.push(
            `Requested track not observed (expected: ${expectedTrack}; observed: ${state.item?.uri ?? 'none'})`,
          );
        }
        if (expectedContext && state.context?.uri !== expectedContext) {
          issues.push(
            `Requested context not observed (expected: ${expectedContext}; observed: ${state.context?.uri ?? 'none'})`,
          );
        }
      }
    }
    if (issues.length === 0) {
      return {
        ok: true,
        note: needsPlayback
          ? 'Playback confirmed by Spotify on the observed device at operation completion.'
          : 'Target device confirmed; transfer did not request playback to start.',
      };
    }
    observation = `${issues.join('. ')}.`;
  }

  return {
    ok: false,
    code: 'bad_response',
    error: `Spotify accepted ${operation.action}, but ${needsPlayback ? 'playback' : 'transfer'} was not confirmed after 5 state checks. ${observation}`,
    note: recovery,
  };
}
