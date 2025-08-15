# Spotify Web API — Tracks & Library (Clean Reference)

Readable extracts for track and library endpoints. All Web API requests use `Authorization: Bearer <token>`.

Base: `https://api.spotify.com/v1`

---

## Get Track

Get catalog information for a single track by ID.

- GET `/tracks/{id}`
- Query: `market?` (ISO country)

```bash
curl --request GET \
  --url https://api.spotify.com/v1/tracks/11dFghVXANMlKmJXsNCbNl \
  --header 'Authorization: Bearer TOKEN'
```

Response (trimmed):

```json
{
  "id": "11dFghVXANMlKmJXsNCbNl",
  "name": "Song name",
  "uri": "spotify:track:11dFghVXANMlKmJXsNCbNl",
  "duration_ms": 215000,
  "explicit": false,
  "album": { "id": "2up3OPMp9Tb4dAKM2erWXQ", "name": "Album" },
  "artists": [{ "id": "1vCWHaC5f2uS3yhpwWbIA6", "name": "Artist" }]
}
```

---

## Get Several Tracks

Get multiple tracks by IDs.

- GET `/tracks`
- Query: `ids` (comma‑separated, up to 50), `market?`

```bash
curl --request GET \
  --url 'https://api.spotify.com/v1/tracks?ids=7ouMYWpwJ422jRcDASZB7P,4VqPOruhp5EdPBeR92t6lQ,2takcwOaAZWiXQijPHIx7B' \
  --header 'Authorization: Bearer TOKEN'
```

Response (trimmed):

```json
{ "tracks": [{ "id": "7ouMYWpwJ422jRcDASZB7P", "name": "…" }] }
```

---

## Get User's Saved Tracks

List songs saved in the current user's library.

- GET `/me/tracks`
- Scopes: `user-library-read`
- Query: `market?`, `limit?` (1..50, default 20), `offset?`

```bash
curl --request GET \
  --url 'https://api.spotify.com/v1/me/tracks?limit=10&offset=0' \
  --header 'Authorization: Bearer USER_TOKEN'
```

Response (trimmed):

```json
{
  "items": [
    {
      "added_at": "2024-01-01T00:00:00Z",
      "track": {
        "id": "2up3OPMp9Tb4dAKM2erWXQ",
        "name": "…",
        "uri": "spotify:track:…"
      }
    }
  ],
  "limit": 10,
  "offset": 0,
  "total": 123
}
```

---

## Save Tracks for Current User

Save tracks to the current user's library.

- PUT `/me/tracks`
- Scopes: `user-library-modify`
- Body: `{ ids: string[] }` (up to 50) — or `timestamped_ids` support where available

```bash
curl --request PUT \
  --url https://api.spotify.com/v1/me/tracks \
  --header 'Authorization: Bearer USER_TOKEN' \
  --header 'Content-Type: application/json' \
  --data '{ "ids": ["4iV5W9uYEdYUVa79Axb7Rh", "1301WleyT98MSxVHPZCA6M"] }'
```

Response: 200/204 empty

---

## Remove User's Saved Tracks

Remove tracks from the current user's library.

- DELETE `/me/tracks`
- Scopes: `user-library-modify`
- Query or Body: `ids` (up to 50) — prefer JSON body

```bash
curl --request DELETE \
  --url 'https://api.spotify.com/v1/me/tracks' \
  --header 'Authorization: Bearer USER_TOKEN' \
  --header 'Content-Type: application/json' \
  --data '{ "ids": ["7ouMYWpwJ422jRcDASZB7P", "4VqPOruhp5EdPBeR92t6lQ"] }'
```

Response: 200/204 empty

---

## Check User's Saved Tracks

Check if tracks are already saved in the current user's library.

- GET `/me/tracks/contains`
- Scopes: `user-library-read`
- Query: `ids` (comma‑separated, up to 50)

```bash
curl --request GET \
  --url 'https://api.spotify.com/v1/me/tracks/contains?ids=7ouMYWpwJ422jRcDASZB7P,4VqPOruhp5EdPBeR92t6lQ' \
  --header 'Authorization: Bearer USER_TOKEN'
```

Response:

```json
[false, true]
```

---

## Notes

- Market and user country affect availability.
- For bulk ops, chunk `ids` at 50.
- Treat 204 responses as success for control‑style endpoints; library endpoints often return 200/204 with empty body.
