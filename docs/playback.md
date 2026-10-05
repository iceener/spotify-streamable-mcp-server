# Playback control

Spotify answers a play or transfer command with `204` when it accepts the command. A `204` does not prove that the device plays. `spotify_control` therefore reads the player state back before it reports success. The code is in `src/tools/spotify-control.ts` and `src/tools/shared/playback.ts`; the tests are in `tests/tools/spotify-control.test.ts`.

## Verification

After each `play`, and after each `transfer`:

1. The tool reads `GET /me/player` at once, then up to four more times, one second apart. It never sends the command again.
2. One state answer must meet all of these conditions:
   - If the operation names a `device_id`, the state shows that device.
   - For `play`, and for `transfer` with `transfer_play: true`: the state shows a device, `is_playing: true`, and a current item.
   - For `play` with a track (`uris`, or `offset.uri`): the current item is that track, or a relinked version of it (`linked_from`).
   - For `play` with a `context_uri`: the state shows that context.
3. If no answer meets the conditions, the operation result is `ok: false` with code `bad_response`, the last observation, and a recovery note. The tool result is an MCP error (`isError: true`).
4. If a state read fails (401, 403, 429, network), the tool stops at once and reports the failure. It does not read again.

Sequential batches (the default) verify each play or transfer before the next operation starts. A batch with `parallel: true` that has a play or transfer and another playback operation is refused before anything is sent, because Spotify does not keep the order of concurrent commands.

The final status line of a batch is a snapshot. A later `pause` can show "Playback is paused" after a verified `play`; that is correct.

## Target device

When `play` names no `device_id`, the tool chooses the active device. It prefers an active device of type `Computer` whose name does not contain "Web Player", because Spotify's Web Player in a browser also reports type `Computer`. An explicit `device_id` always wins. The tool never activates an inactive device on its own.

## When playback does not start

Spotify accepts the command, but nothing plays. Do these steps:

1. On the target device, open Spotify with the same Premium account, and play a track by hand once.
2. Call `player_status` to get the current device IDs.
3. Retry with the new `device_id`.

If the track does not play by hand either, the cause is the account or the market of the track, not the server.

## Known limit

`@spotify/web-api-ts-sdk` 1.2.0 sends a play command's start position as `positionMs`. Spotify expects `position_ms` and ignores the field, so `position_ms` on `play` has no effect. Use `seek` after `play` instead. This was so before 1.1.0 too; `tests/services/spotify.test.ts` records it.
