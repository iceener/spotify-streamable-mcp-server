# Spotify Web API — Player (Clean Reference)

Player endpoints used for status and control. Requires Premium for most control operations. All Web API requests use `Authorization: Bearer <token>`.

Base: `https://api.spotify.com/v1`

---

## Get Playback State

Get information about the user’s current playback state (device, context, progress, etc.).

- GET `/me/player`
- Scopes: `user-read-playback-state`
- Query: `market?`, `additional_types?=track,episode`

```bash
curl --request GET \
  --url https://api.spotify.com/v1/me/player \
  --header 'Authorization: Bearer USER_TOKEN'
```

Response (trimmed):

```json
{
  "device": {
    "id": "74AS...",
    "name": "Kitchen speaker",
    "type": "computer",
    "volume_percent": 59
  },
  "repeat_state": "off",
  "shuffle_state": false,
  "context": { "type": "playlist", "uri": "spotify:playlist:..." },
  "timestamp": 1710000000000,
  "progress_ms": 12345,
  "is_playing": true,
  "item": { "id": "2up3...", "name": "Track", "duration_ms": 210000 },
  "currently_playing_type": "track"
}
```

---

## Get Available Devices

List available Spotify Connect devices for the user.

- GET `/me/player/devices`
- Scopes: `user-read-playback-state`

```bash
curl --request GET \
  --url https://api.spotify.com/v1/me/player/devices \
  --header 'Authorization: Bearer USER_TOKEN'
```

Response (trimmed):

```json
{
  "devices": [
    {
      "id": "74AS...",
      "name": "Kitchen speaker",
      "type": "computer",
      "is_active": true
    }
  ]
}
```

---

## Get Currently Playing

Get the object currently being played on the user's account.

- GET `/me/player/currently-playing`
- Scopes: `user-read-currently-playing`

```bash
curl --request GET \
  --url https://api.spotify.com/v1/me/player/currently-playing \
  --header 'Authorization: Bearer USER_TOKEN'
```

Response: 200 with payload, or 204 if nothing is playing

---

## Transfer Playback

Transfer playback to a new device.

- PUT `/me/player`
- Scopes: `user-modify-playback-state`
- Body: `{ device_ids: string[], play?: boolean }`

```bash
curl --request PUT \
  --url https://api.spotify.com/v1/me/player \
  --header 'Authorization: Bearer USER_TOKEN' \
  --header 'Content-Type: application/json' \
  --data '{ "device_ids": ["74ASZWbe4lXaubB36ztrGX"], "play": true }'
```

Response: 204 empty

---

## Start/Resume Playback

Start a context or resume playback on the active (or specified) device.

- PUT `/me/player/play`
- Scopes: `user-modify-playback-state`
- Query: `device_id?`
- Body: `{ context_uri?, uris?, offset?, position_ms? }`

```bash
curl --request PUT \
  --url 'https://api.spotify.com/v1/me/player/play?device_id=DEVICE_ID' \
  --header 'Authorization: Bearer USER_TOKEN' \
  --header 'Content-Type: application/json' \
  --data '{ "context_uri": "spotify:album:5ht7ItJgpBH7W6vJ5BqpPr", "offset": { "position": 5 }, "position_ms": 0 }'
```

Response: 204 empty

---

## Pause Playback

- PUT `/me/player/pause`
- Scopes: `user-modify-playback-state`
- Query: `device_id?`

```bash
curl --request PUT \
  --url 'https://api.spotify.com/v1/me/player/pause?device_id=DEVICE_ID' \
  --header 'Authorization: Bearer USER_TOKEN'
```

Response: 204 empty

---

## Next / Previous

- POST `/me/player/next`
- POST `/me/player/previous`
- Scopes: `user-modify-playback-state`
- Query: `device_id?`

```bash
curl --request POST \
  --url 'https://api.spotify.com/v1/me/player/next?device_id=DEVICE_ID' \
  --header 'Authorization: Bearer USER_TOKEN'
```

Response: 204 empty

---

## Seek To Position

- PUT `/me/player/seek`
- Scopes: `user-modify-playback-state`
- Query: `position_ms` (required), `device_id?`

```bash
curl --request PUT \
  --url 'https://api.spotify.com/v1/me/player/seek?position_ms=25000&device_id=DEVICE_ID' \
  --header 'Authorization: Bearer USER_TOKEN'
```

Response: 204 empty

---

## Set Repeat Mode

- PUT `/me/player/repeat`
- Scopes: `user-modify-playback-state`
- Query: `state` (off|track|context), `device_id?`

```bash
curl --request PUT \
  --url 'https://api.spotify.com/v1/me/player/repeat?state=context&device_id=DEVICE_ID' \
  --header 'Authorization: Bearer USER_TOKEN'
```

Response: 204 empty

---

## Set Playback Volume

- PUT `/me/player/volume`
- Scopes: `user-modify-playback-state`
- Query: `volume_percent` (0..100), `device_id?`

```bash
curl --request PUT \
  --url 'https://api.spotify.com/v1/me/player/volume?volume_percent=50&device_id=DEVICE_ID' \
  --header 'Authorization: Bearer USER_TOKEN'
```

Response: 204 empty

---

## Toggle Shuffle

- PUT `/me/player/shuffle`
- Scopes: `user-modify-playback-state`
- Query: `state` (true|false), `device_id?`

```bash
curl --request PUT \
  --url 'https://api.spotify.com/v1/me/player/shuffle?state=true&device_id=DEVICE_ID' \
  --header 'Authorization: Bearer USER_TOKEN'
```

Response: 204 empty

---

## Get Recently Played Tracks

- GET `/me/player/recently-played`
- Scopes: `user-read-recently-played`
- Query: `limit?` (1..50), `after?` (ms), `before?` (ms)

```bash
curl --request GET \
  --url 'https://api.spotify.com/v1/me/player/recently-played?limit=10' \
  --header 'Authorization: Bearer USER_TOKEN'
```

Response (trimmed):

```json
{
  "items": [
    {
      "track": { "id": "2up3...", "name": "…" },
      "played_at": "2024-01-01T00:00:00Z"
    }
  ],
  "limit": 10,
  "cursors": { "after": "..." },
  "total": 100
}
```

---

## Get Queue

- GET `/me/player/queue`
- Scopes: `user-read-currently-playing`, `user-read-playback-state`

```bash
curl --request GET \
  --url https://api.spotify.com/v1/me/player/queue \
  --header 'Authorization: Bearer USER_TOKEN'
```

Response (trimmed):

```json
{ "currently_playing": { "id": "2up3..." }, "queue": [{ "id": "4iV5..." }] }
```

---

## Add to Queue

- POST `/me/player/queue`
- Scopes: `user-modify-playback-state`
- Query: `uri` (track/episode URI), `device_id?`

```bash
curl --request POST \
  --url 'https://api.spotify.com/v1/me/player/queue?uri=spotify:track:4iV5W9uYEdYUVa79Axb7Rh&device_id=DEVICE_ID' \
  --header 'Authorization: Bearer USER_TOKEN'
```

Response: 204 empty
