# Mac: play acknowledged while playback stays paused

The false success is an mcp-spotify bug, independent of Alice. The control handler marked every non-throwing play/transfer PUT `ok: true`, counted it as successful, then appended a status message without revising the result. Play polling tested track identity, not `is_playing` or target device; missing state and read errors were ignored. Transfer did not verify its outcome. Thus an HTTP 204 plus an active device, `is_playing: false`, and no item became “Successful: play. Playback is paused.”

After the fix, each play/transfer is verified before the next sequential operation. Five read-only checks, immediately and then at one-second intervals, require the target device when specified. Play and `transfer_play: true` also require `is_playing: true` and a current item; explicit track/context requests must match (including Spotify track relinking). Transfer without `transfer_play` only verifies the target, because false preserves playback state rather than requesting playback. Unconfirmed outcomes return `ok: false`, `isError: true`, failure counts, observed mismatch, and a recovery note. Read errors retain authorization/rate-limit categories. Conflicting parallel playback batches are rejected before any writes. Output schemas are unchanged.

## What Adam should do

Ask Spotify on the Mac to play Pretoria once manually, using the same Premium account connected to the MCP. Then refresh devices with `player_status` and retry on the returned ID. Opening/restarting the desktop app is a Connect recovery step, not a documented requirement to keep its window foreground. If only this track fails manually, check track/account availability; if all tracks fail, restart Spotify or choose another Connect device. Do not repeatedly transfer/play on an active-but-empty endpoint.

## Evidence and limits

- A deterministic real-SDK/mock-fetch regression reproduces the supplied device/track and 204 + paused/empty responses. Before the fix it failed (`isError` was false); after the fix it passed. Logs: `/tmp/spotify-mcp-play-a8c4fa25/before.log` and `first-fix.log`.
- Spotify documents Premium and `user-modify-playback-state` for play/transfer, and explicitly warns that execution order with other Player endpoints is not guaranteed. Both modification and state-read scopes are in this repo’s default OAuth scopes. An existing token’s actual scopes/account were not inspected. Non-2xx writes already throw through the SDK validator; verification errors were the swallowed errors.
- An ACTIVE device identifies the Connect target, not proof of playback. Spotify documents `is_restricted: true` as a device that will not accept Web API commands. No supplied observation establishes a device restriction, missing Premium, missing permission, or track-market restriction.
- Catalog search uses app credentials with optional market. Finding a track is not proof that a particular user can play it. Playback uses the resolved user credential; the play endpoint has no market parameter. The user’s account country governs availability. No account/market bypass was added.
- No live authenticated Spotify request or desktop manipulation was performed; `.env` was not read. The reporting defect is proven. The reason Spotify did not start Adam’s desktop playback is not recoverable from a 204 and empty state alone. This change reports that uncertainty honestly; it does not claim to repair Spotify Connect or prove audible playback.
- Verification is bounded by five responses plus four seconds of waits, not a hard network deadline. A very slow transition is reported unconfirmed, not permanently rejected. Results describe state at each operation’s completion; final status can legitimately be paused after a later pause. Context position offsets cannot be resolved to an exact track without a catalog lookup; URI offsets can.

References retrieved for this diagnosis:
- https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback
- https://developer.spotify.com/documentation/web-api/reference/transfer-a-users-playback
- https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback
- https://developer.spotify.com/documentation/web-api/reference/get-a-users-available-devices
- https://developer.spotify.com/documentation/web-api/reference/get-track

Source seam: `src/shared/tools/spotify-control.ts`; verification: `src/shared/tools/playback-verification.ts`; state decoding: `src/types/spotify.codecs.ts`. The SDK 1.2.0 also serializes play’s optional position as `positionMs`, not Spotify’s `position_ms`; this is separate from the supplied plain-track reproduction and has not been changed in this slice.
