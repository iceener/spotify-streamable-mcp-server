# Spotify Web API — Playlists (Clean Reference)

Readable extracts for playlist endpoints used by this repo. All Web API requests use `Authorization: Bearer <token>`.

Base: `https://api.spotify.com/v1`

---

## Get Playlist

Get a playlist owned by a Spotify user.

- GET `/playlists/{playlist_id}`
- Query: `market?` (ISO country), `fields?` (filter), `additional_types?=track|episode`

```bash
curl --request GET \
  --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n \
  --header 'Authorization: Bearer USER_ACCESS_TOKEN'
```

Response (trimmed):

```json
{
  "id": "3cEYpjA9oz9GiPac4AsH4n",
  "name": "Playlist name",
  "images": [
    { "url": "https://i.scdn.co/image/...", "height": 300, "width": 300 }
  ],
  "owner": { "id": "user_id", "display_name": "User" },
  "public": false,
  "snapshot_id": "abc",
  "tracks": {
    "href": "https://api.spotify.com/v1/playlists/3cEY.../tracks",
    "total": 42
  },
  "type": "playlist",
  "uri": "spotify:playlist:3cEYpjA9oz9GiPac4AsH4n"
}
```

---

## Change Playlist Details

Change name/description/public status.

- PUT `/playlists/{playlist_id}`
- Body: `{ name?, public?, collaborative?, description? }`

```bash
curl --request PUT \
  --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n \
  --header 'Authorization: Bearer USER_ACCESS_TOKEN' \
  --header 'Content-Type: application/json' \
  --data '{
    "name": "Updated Playlist Name",
    "description": "Updated playlist description",
    "public": false
  }'
```

Response: 200/204 empty

---

## Get Playlist Items

List items of a playlist.

- GET `/playlists/{playlist_id}/tracks`
- Query: `market?`, `fields?`, `limit?` (1..50, default 20), `offset?` (0..)

```bash
curl --request GET \
  --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n/tracks \
  --header 'Authorization: Bearer USER_ACCESS_TOKEN'
```

Response (trimmed):

```json
{
  "href": "https://api.spotify.com/v1/playlists/.../tracks?offset=0&limit=20",
  "items": [
    {
      "added_at": "2024-01-01T00:00:00Z",
      "track": {
        "id": "2up3OPMp9Tb4dAKM2erWXQ",
        "name": "Track name",
        "uri": "spotify:track:2up3OPMp9Tb4dAKM2erWXQ"
      }
    }
  ],
  "limit": 20,
  "offset": 0,
  "total": 4
}
```

---

## Update Playlist Items (Reorder or Replace)

Reorder or replace items depending on the request parameters. Operations are mutually exclusive.

- PUT `/playlists/{playlist_id}/tracks`
- Reorder body: `{ range_start, insert_before, range_length?, snapshot_id? }`

```bash
curl --request PUT \
  --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n/tracks \
  --header 'Authorization: Bearer USER_ACCESS_TOKEN' \
  --header 'Content-Type: application/json' \
  --data '{
    "range_start": 1,
    "insert_before": 3,
    "range_length": 2
  }'
```

Response:

```json
{ "snapshot_id": "abc" }
```

- Replace body: `{ uris: string[] }` (up to 100)

---

## Add Items to Playlist

Add one or more items.

- POST `/playlists/{playlist_id}/tracks`
- Query/body: `uris` as comma list or JSON body `{ uris: string[], position? }`

```bash
curl --request POST \
  --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n/tracks \
  --header 'Authorization: Bearer USER_ACCESS_TOKEN' \
  --header 'Content-Type: application/json' \
  --data '{
    "uris": [
      "spotify:track:4iV5W9uYEdYUVa79Axb7Rh",
      "spotify:track:1301WleyT98MSxVHPZCA6M"
    ],
    "position": 0
  }'
```

Response:

```json
{ "snapshot_id": "abc" }
```

---

## Remove Playlist Items

Remove items by URI.

- DELETE `/playlists/{playlist_id}/tracks`
- Body: `{ tracks: [{ uri: string }...], snapshot_id? }` (up to 100)

```bash
curl --request DELETE \
  --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n/tracks \
  --header 'Authorization: Bearer USER_ACCESS_TOKEN' \
  --header 'Content-Type: application/json' \
  --data '{
    "tracks": [{ "uri": "spotify:track:4iV5W9uYEdYUVa79Axb7Rh" }]
  }'
```

Response:

```json
{ "snapshot_id": "abc" }
```

---

## Get Current User's Playlists

List playlists for the current user.

- GET `/me/playlists`
- Query: `limit?` (1..50, default 20), `offset?`

```bash
curl --request GET \
  --url 'https://api.spotify.com/v1/me/playlists?limit=10' \
  --header 'Authorization: Bearer USER_ACCESS_TOKEN'
```

Response (trimmed):

```json
{
  "href": "https://api.spotify.com/v1/me/playlists?offset=0&limit=10",
  "items": [
    {
      "id": "37i9dQZF1DXcBWIGoYBM5M",
      "name": "Today's Top Hits",
      "uri": "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"
    }
  ],
  "limit": 10,
  "offset": 0,
  "total": 42
}
```

---

## Get User's Playlists

List playlists for the given user.

- GET `/users/{user_id}/playlists`
- Query: `limit?` (1..50), `offset?`

```bash
curl --request GET \
  --url https://api.spotify.com/v1/users/smedjan/playlists \
  --header 'Authorization: Bearer USER_ACCESS_TOKEN'
```

---

## Follow/Unfollow Playlist

- PUT `/playlists/{playlist_id}/followers` body `{ public?: boolean }`
- DELETE `/playlists/{playlist_id}/followers`

```bash
curl --request PUT \
  --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n/followers \
  --header 'Authorization: Bearer USER_ACCESS_TOKEN' \
  --header 'Content-Type: application/json' \
  --data '{ "public": false }'
```

Response: 200/204 empty

---

## Check if Current User Follows Playlist

- GET `/playlists/{playlist_id}/followers/contains`

```bash
curl --request GET \
  --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n/followers/contains \
  --header 'Authorization: Bearer USER_ACCESS_TOKEN'
```

Response:

```json
[true]
```

# Web API •

References / Playlists / Get Playlist
Get Playlist

OAuth 2.0
Get a playlist owned by a Spotify user.

Important policy notes
Spotify content may not be downloaded
Keep visual content in its original form
Ensure content attribution
Spotify content may not be used to train machine learning or AI model
Request

GET
/playlists/{playlist_id}
playlist_id
string
Required
The Spotify ID of the playlist.

Example: 3cEYpjA9oz9GiPac4AsH4n
market
string
An ISO 3166-1 alpha-2 country code. If a country code is specified, only content that is available in that market will be returned.
If a valid user access token is specified in the request header, the country associated with the user account will take priority over this parameter.
Note: If neither market or user country are provided, the content is considered unavailable for the client.
Users can view the country that is associated with their account in the account settings.

Example: market=ES
fields
string
Filters for the query: a comma-separated list of the fields to return. If omitted, all fields are returned. For example, to get just the playlist''s description and URI: fields=description,uri. A dot separator can be used to specify non-reoccurring fields, while parentheses can be used to specify reoccurring fields within objects. For example, to get just the added date and user ID of the adder: fields=tracks.items(added_at,added_by.id). Use multiple parentheses to drill down into nested objects, for example: fields=tracks.items(track(name,href,album(name,href))). Fields can be excluded by prefixing them with an exclamation mark, for example: fields=tracks.items(track(name,href,album(!name,href)))

Example: fields=items(added_by.id,track(name,href,album(name,href)))
additional_types
string
A comma-separated list of item types that your client supports besides the default track type. Valid types are: track and episode.
Note: This parameter was introduced to allow existing clients to maintain their current behaviour and might be deprecated in the future.
In addition to providing this parameter, make sure that your client properly handles cases of new types in the future by checking against the type field of each object.

Response
200
401
403
429
A playlist

collaborative
boolean
true if the owner allows other users to modify the playlist.

description
string
Nullable
The playlist description. Only returned for modified, verified playlists, otherwise null.

external_urls
object
Known external URLs for this playlist.

spotify
string
The Spotify URL for the object.

href
string
A link to the Web API endpoint providing full details of the playlist.

id
string
The Spotify ID for the playlist.

images
array of ImageObject
Images for the playlist. The array may be empty or contain up to three images. The images are returned by size in descending order. See Working with Playlists. Note: If returned, the source URL for the image (url) is temporary and will expire in less than a day.

url
string
Required
The source URL of the image.

Example: "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228"
height
integer
Required
Nullable
The image height in pixels.

Example: 300
width
integer
Required
Nullable
The image width in pixels.

Example: 300
name
string
The name of the playlist.

owner
object
The user who owns the playlist

external_urls
object
Known public external URLs for this user.

href
string
A link to the Web API endpoint for this user.

id
string
The Spotify user ID for this user.

type
string
The object type.

Allowed values: "user"
uri
string
The Spotify URI for this user.

display_name
string
Nullable
The name displayed on the user's profile. null if not available.

public
boolean
The playlist's public/private status (if it is added to the user's profile): true the playlist is public, false the playlist is private, null the playlist status is not relevant. For more about public/private status, see Working with Playlists

snapshot_id
string
The version identifier for the current playlist. Can be supplied in other requests to target a specific playlist version

tracks
object
The tracks of the playlist.

href
string
Required
A link to the Web API endpoint returning the full result of the request

Example: "https://api.spotify.com/v1/me/shows?offset=0&limit=20"
limit
integer
Required
The maximum number of items in the response (as set in the query or by default).

Example: 20
next
string
Required
Nullable
URL to the next page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
offset
integer
Required
The offset of the items returned (as set in the query or by default)

Example: 0
previous
string
Required
Nullable
URL to the previous page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
total
integer
Required
The total number of items available to return.

Example: 4

items
array of PlaylistTrackObject
Required
type
string
The object type: "playlist"

uri
string
The Spotify URI for the playlist.

endpoint
https://api.spotify.com/v1/playlists/{playlist_id}
playlist_id
3cEYpjA9oz9GiPac4AsH4n
market
ES
fields
items(added_by.id,track(name,href,album(name,href)))
additional_types
Request sample

cURL

Wget

HTTPie

```bash
curl --request GET \
 --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z'
```

Response sample

```json
{
"collaborative": false,
"description": "string",
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"name": "string",
"owner": {
"external_urls": {
"spotify": "string"
},
"href": "string",
"id": "string",
"type": "user",
"uri": "string",
"display_name": "string"
},
"public": false,
"snapshot_id": "string",
"tracks": {
"href": "https://api.spotify.com/v1/me/shows?offset=0&limit=20",
"limit": 20,
"next": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"offset": 0,
"previous": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"total": 4,
"items": [

```json
{
"added_at": "string",
"added_by": {
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"type": "user",
"uri": "string"
},
"is_local": false,
"track": {
"album": {
"album_type": "compilation",
"total_tracks": 9,
"available_markets": ["CA", "BR", "IT"],
"external_urls": {
"spotify": "string"
},
"href": "string",
"id": "2up3OPMp9Tb4dAKM2erWXQ",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"name": "string",
"release_date": "1981-12",
"release_date_precision": "year",
"restrictions": {
"reason": "market"
},
"type": "album",
"uri": "spotify:album:2up3OPMp9Tb4dAKM2erWXQ",
"artists": [

```json
{
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"name": "string",
"type": "artist",
"uri": "string"
}
]
},
"artists": [

```json
{
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"name": "string",
"type": "artist",
"uri": "string"
}
],
"available_markets": ["string"],
"disc_number": 0,
"duration_ms": 0,
"explicit": false,
"external_ids": {
"isrc": "string",
"ean": "string",
"upc": "string"
},
"external_urls": {
"spotify": "string"
},
"href": "string",
"id": "string",
"is_playable": false,
"linked_from": {
},
"restrictions": {
"reason": "string"
},
"name": "string",
"popularity": 0,
"preview_url": "string",
"track_number": 0,
"type": "track",
"uri": "string",
"is_local": false
}
}
]
},
"type": "string",
"uri": "string"
}
Web API •
References / Playlists / Change Playlist Details
Change Playlist Details

OAuth 2.0
Change a playlist's name and public/private state. (The user must, of course, own the playlist.)

Authorization scopes
playlist-modify-public
playlist-modify-private
Request

PUT
/playlists/{playlist_id}
playlist_id
string
Required
The Spotify ID of the playlist.

Example: 3cEYpjA9oz9GiPac4AsH4n
Body application/json
supports free form additional properties
name
string
The new name for the playlist, for example "My New Playlist Title"

public
boolean
The playlist's public/private status (if it should be added to the user's profile or not): true the playlist will be public, false the playlist will be private, null the playlist status is not relevant. For more about public/private status, see Working with Playlists

collaborative
boolean
If true, the playlist will become collaborative and other users will be able to modify the playlist in their Spotify client.
Note: You can only set collaborative to true on non-public playlists.

description
string
Value for playlist description as displayed in Spotify Clients and in the Web API.

Response
200
401
403
429
Playlist updated

endpoint
https://api.spotify.com/v1/playlists/{playlist_id}
playlist_id
3cEYpjA9oz9GiPac4AsH4n
Request body

```json
{
  "name": "Updated Playlist Name",
  "description": "Updated playlist description",
  "public": false
}
```

```json
{
  "name": "Updated Playlist Name",
  "description": "Updated playlist description",
  "public": false
}
```

Request sample

cURL

Wget

HTTPie

```bash
curl --request PUT \
 --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z' \
 --header 'Content-Type: application/json' \
 --data '{
"name": "Updated Playlist Name",
"description": "Updated playlist description",
"public": false
}'
```

Response sample
empty responseWeb API •
References / Playlists / Get Playlist Items
Get Playlist Items

OAuth 2.0
Get full details of the items of a playlist owned by a Spotify user.

Important policy notes
Spotify content may not be downloaded
Keep visual content in its original form
Ensure content attribution
Spotify content may not be used to train machine learning or AI model
Authorization scopes
playlist-read-private
Request

GET
/playlists/{playlist_id}/tracks
playlist_id
string
Required
The Spotify ID of the playlist.

Example: 3cEYpjA9oz9GiPac4AsH4n
market
string
An ISO 3166-1 alpha-2 country code. If a country code is specified, only content that is available in that market will be returned.
If a valid user access token is specified in the request header, the country associated with the user account will take priority over this parameter.
Note: If neither market or user country are provided, the content is considered unavailable for the client.
Users can view the country that is associated with their account in the account settings.

Example: market=ES
fields
string
Filters for the query: a comma-separated list of the fields to return. If omitted, all fields are returned. For example, to get just the total number of items and the request limit:
fields=total,limit
A dot separator can be used to specify non-reoccurring fields, while parentheses can be used to specify reoccurring fields within objects. For example, to get just the added date and user ID of the adder:
fields=items(added_at,added_by.id)
Use multiple parentheses to drill down into nested objects, for example:
fields=items(track(name,href,album(name,href)))
Fields can be excluded by prefixing them with an exclamation mark, for example:
fields=items.track.album(!external_urls,images)

Example: fields=items(added_by.id,track(name,href,album(name,href)))
limit
integer
The maximum number of items to return. Default: 20. Minimum: 1. Maximum: 50.

Default: limit=20
Range: 0 - 50
Example: limit=10
offset
integer
The index of the first item to return. Default: 0 (the first item). Use with limit to get the next set of items.

Default: offset=0
Example: offset=5
additional_types
string
A comma-separated list of item types that your client supports besides the default track type. Valid types are: track and episode.
Note: This parameter was introduced to allow existing clients to maintain their current behaviour and might be deprecated in the future.
In addition to providing this parameter, make sure that your client properly handles cases of new types in the future by checking against the type field of each object.

Response
200
401
403
429
Pages of tracks

href
string
Required
A link to the Web API endpoint returning the full result of the request

Example: "https://api.spotify.com/v1/me/shows?offset=0&limit=20"
limit
integer
Required
The maximum number of items in the response (as set in the query or by default).

Example: 20
next
string
Required
Nullable
URL to the next page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
offset
integer
Required
The offset of the items returned (as set in the query or by default)

Example: 0
previous
string
Required
Nullable
URL to the previous page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
total
integer
Required
The total number of items available to return.

Example: 4

items
array of PlaylistTrackObject
Required
added_at
string [date-time]
The date and time the track or episode was added. Note: some very old playlists may return null in this field.

added_by
object
The Spotify user who added the track or episode. Note: some very old playlists may return null in this field.

is_local
boolean
Whether this track or episode is a local file or not.

track
oneOf
Information about the track or episode.

Will be one of the following:

TrackObject
object

EpisodeObject
object
endpoint
https://api.spotify.com/v1/playlists/{playlist_id}/tracks
playlist_id
3cEYpjA9oz9GiPac4AsH4n
market
ES
fields
items(added_by.id,track(name,href,album(name,href)))
limit
10
offset
5
additional_types
Request sample

cURL

Wget

HTTPie

```bash
curl --request GET \
 --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n/tracks \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z'
```

Response sample

```json
{
"href": "https://api.spotify.com/v1/me/shows?offset=0&limit=20",
"limit": 20,
"next": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"offset": 0,
"previous": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"total": 4,
"items": [
{
"added_at": "string",
"added_by": {
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"type": "user",
"uri": "string"
},
"is_local": false,
"track": {
"album": {
"album_type": "compilation",
"total_tracks": 9,
"available_markets": ["CA", "BR", "IT"],
"external_urls": {
"spotify": "string"
},
"href": "string",
"id": "2up3OPMp9Tb4dAKM2erWXQ",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"name": "string",
"release_date": "1981-12",
"release_date_precision": "year",
"restrictions": {
"reason": "market"
},
"type": "album",
"uri": "spotify:album:2up3OPMp9Tb4dAKM2erWXQ",
"artists": [

```json
{
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"name": "string",
"type": "artist",
"uri": "string"
}
]
},
"artists": [

```json
{
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"name": "string",
"type": "artist",
"uri": "string"
}
],
"available_markets": ["string"],
"disc_number": 0,
"duration_ms": 0,
"explicit": false,
"external_ids": {
"isrc": "string",
"ean": "string",
"upc": "string"
},
"external_urls": {
"spotify": "string"
},
"href": "string",
"id": "string",
"is_playable": false,
"linked_from": {
},
"restrictions": {
"reason": "string"
},
"name": "string",
"popularity": 0,
"preview_url": "string",
"track_number": 0,
"type": "track",
"uri": "string",
"is_local": false
}
}
]
}Update Playlist Items

OAuth 2.0
Either reorder or replace items in a playlist depending on the request's parameters. To reorder items, include range_start, insert_before, range_length and snapshot_id in the request's body. To replace items, include uris as either a query parameter or in the request's body. Replacing items in a playlist will overwrite its existing items. This operation can be used for replacing or clearing items in a playlist.

Note: Replace and reorder are mutually exclusive operations which share the same endpoint, but have different parameters. These operations can't be applied together in a single request.

Authorization scopes
playlist-modify-public
playlist-modify-private
Request

PUT
/playlists/{playlist_id}/tracks
playlist_id
string
Required
The Spotify ID of the playlist.

Example: 3cEYpjA9oz9GiPac4AsH4n
uris
string
A comma-separated list of Spotify URIs to set, can be track or episode URIs. For example: uris=spotify:track:4iV5W9uYEdYUVa79Axb7Rh,spotify:track:1301WleyT98MSxVHPZCA6M,spotify:episode:512ojhOuo1ktJprKbVcKyQ
A maximum of 100 items can be set in one request.

Body application/json
supports free form additional properties
uris
array of strings
range_start
integer
The position of the first item to be reordered.

insert_before
integer
The position where the items should be inserted.
To reorder the items to the end of the playlist, simply set insert_before to the position after the last item.
Examples:
To reorder the first item to the last position in a playlist with 10 items, set range_start to 0, and insert_before to 10.
To reorder the last item in a playlist with 10 items to the start of the playlist, set range_start to 9, and insert_before to 0.

range_length
integer
The amount of items to be reordered. Defaults to 1 if not set.
The range of items to be reordered begins from the range_start position, and includes the range_length subsequent items.
Example:
To move the items at index 9-10 to the start of the playlist, range_start is set to 9, and range_length is set to 2.

snapshot_id
string
The playlist's snapshot ID against which you want to make the changes.

Response
200
401
403
429
A snapshot ID for the playlist

snapshot_id
string
Example: "abc"
endpoint
https://api.spotify.com/v1/playlists/{playlist_id}/tracks
playlist_id
3cEYpjA9oz9GiPac4AsH4n
uris
Request body

```json
{
  "range_start": 1,
  "insert_before": 3,
  "range_length": 2
}
```

```json
{
  "range_start": 1,
  "insert_before": 3,
  "range_length": 2
}
```

Request sample

cURL

Wget

HTTPie

```bash
curl --request PUT \
 --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n/tracks \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z' \
 --header 'Content-Type: application/json' \
 --data '{
"range_start": 1,
"insert_before": 3,
"range_length": 2
}'
```

Response sample

```json
{
"snapshot_id": "abc"
}Web API •
References / Playlists / Add Items to Playlist
Add Items to Playlist

OAuth 2.0
Add one or more items to a user's playlist.

Authorization scopes
playlist-modify-public
playlist-modify-private
Request

POST
/playlists/{playlist_id}/tracks
playlist_id
string
Required
The Spotify ID of the playlist.

Example: 3cEYpjA9oz9GiPac4AsH4n
position
integer
The position to insert the items, a zero-based index. For example, to insert the items in the first position: position=0; to insert the items in the third position: position=2. If omitted, the items will be appended to the playlist. Items are added in the order they are listed in the query string or request body.

Example: position=0
uris
string
A comma-separated list of Spotify URIs to add, can be track or episode URIs. For example:
uris=spotify:track:4iV5W9uYEdYUVa79Axb7Rh, spotify:track:1301WleyT98MSxVHPZCA6M, spotify:episode:512ojhOuo1ktJprKbVcKyQ
A maximum of 100 items can be added in one request.
Note: it is likely that passing a large number of item URIs as a query parameter will exceed the maximum length of the request URI. When adding a large number of items, it is recommended to pass them in the request body, see below.

Example: uris=spotify%3Atrack%3A4iV5W9uYEdYUVa79Axb7Rh,spotify%3Atrack%3A1301WleyT98MSxVHPZCA6M
Body application/json
supports free form additional properties
uris
array of strings
A JSON array of the Spotify URIs to add. For example: {"uris": ["spotify:track:4iV5W9uYEdYUVa79Axb7Rh","spotify:track:1301WleyT98MSxVHPZCA6M", "spotify:episode:512ojhOuo1ktJprKbVcKyQ"]}
A maximum of 100 items can be added in one request. Note: if the uris parameter is present in the query string, any URIs listed here in the body will be ignored.

position
integer
The position to insert the items, a zero-based index. For example, to insert the items in the first position: position=0 ; to insert the items in the third position: position=2. If omitted, the items will be appended to the playlist. Items are added in the order they appear in the uris array. For example: {"uris": ["spotify:track:4iV5W9uYEdYUVa79Axb7Rh","spotify:track:1301WleyT98MSxVHPZCA6M"], "position": 3}

Response
201
401
403
429
A snapshot ID for the playlist

snapshot_id
string
Example: "abc"
endpoint
https://api.spotify.com/v1/playlists/{playlist_id}/tracks
playlist_id
3cEYpjA9oz9GiPac4AsH4n
position
0
uris
spotify:track:4iV5W9uYEdYUVa79Axb7Rh,spotify:track:1301WleyT98MSxVHPZCA6M
Request body
{
"uris": [
"string"
],
```

"position": 0
}

```json
{
"uris": [
"string"
],
```

"position": 0
}
Request sample

cURL

Wget

HTTPie

```bash
curl --request POST \
 --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n/tracks \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z' \
 --header 'Content-Type: application/json' \
 --data '{
"uris": [
"string"
],
"position": 0
}'
```

Response sample

```json
{
"snapshot_id": "abc"
}Web API •
References / Playlists / Remove Playlist Items
Remove Playlist Items

OAuth 2.0
Remove one or more items from a user's playlist.

Authorization scopes
playlist-modify-public
playlist-modify-private
Request

DELETE
/playlists/{playlist_id}/tracks
playlist_id
string
Required
The Spotify ID of the playlist.

Example: 3cEYpjA9oz9GiPac4AsH4n
Body application/json

tracks
array of objects
Required
An array of objects containing Spotify URIs of the tracks or episodes to remove. For example: { "tracks": [{ "uri": "spotify:track:4iV5W9uYEdYUVa79Axb7Rh" },{ "uri": "spotify:track:1301WleyT98MSxVHPZCA6M" }] }. A maximum of 100 objects can be sent at once.

snapshot_id
string
The playlist's snapshot ID against which you want to make the changes. The API will validate that the specified items exist and in the specified positions and make the changes, even if more recent changes have been made to the playlist.

Response
200
401
403
429
A snapshot ID for the playlist

snapshot_id
string
Example: "abc"
endpoint
https://api.spotify.com/v1/playlists/{playlist_id}/tracks
playlist_id
3cEYpjA9oz9GiPac4AsH4n
Request body
{
"tracks": [
{
"uri": "string"
}
```

],
"snapshot_id": "string"
}

```json
{
"tracks": [
{
"uri": "string"
}
```

],
"snapshot_id": "string"
}
Request sample

cURL

Wget

HTTPie

```bash
curl --request DELETE \
 --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n/tracks \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z' \
 --header 'Content-Type: application/json' \
 --data '{
"tracks": [
{
"uri": "string"
}
],
"snapshot_id": "string"
}'
```

Response sample

```json
{
  "snapshot_id": "abc"
}
```

Get Current User's Playlists

OAuth 2.0
Get a list of the playlists owned or followed by the current Spotify user.

Authorization scopes
playlist-read-private
Request

GET
/me/playlists
limit
integer
The maximum number of items to return. Default: 20. Minimum: 1. Maximum: 50.

Default: limit=20
Range: 0 - 50
Example: limit=10
offset
integer
'The index of the first playlist to return. Default: 0 (the first object). Maximum offset: 100.000. Use with limit to get the next set of playlists.'

Default: offset=0
Example: offset=5
Response
200
401
403
429
A paged set of playlists

href
string
Required
A link to the Web API endpoint returning the full result of the request

Example: "https://api.spotify.com/v1/me/shows?offset=0&limit=20"
limit
integer
Required
The maximum number of items in the response (as set in the query or by default).

Example: 20
next
string
Required
Nullable
URL to the next page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
offset
integer
Required
The offset of the items returned (as set in the query or by default)

Example: 0
previous
string
Required
Nullable
URL to the previous page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
total
integer
Required
The total number of items available to return.

Example: 4

items
array of SimplifiedPlaylistObject
Required
collaborative
boolean
true if the owner allows other users to modify the playlist.

description
string
The playlist description. Only returned for modified, verified playlists, otherwise null.

external_urls
object
Known external URLs for this playlist.

href
string
A link to the Web API endpoint providing full details of the playlist.

id
string
The Spotify ID for the playlist.

images
array of ImageObject
Images for the playlist. The array may be empty or contain up to three images. The images are returned by size in descending order. See Working with Playlists. Note: If returned, the source URL for the image (url) is temporary and will expire in less than a day.

name
string
The name of the playlist.

owner
object
The user who owns the playlist

public
boolean
The playlist's public/private status (if it is added to the user's profile): true the playlist is public, false the playlist is private, null the playlist status is not relevant. For more about public/private status, see Working with Playlists

snapshot_id
string
The version identifier for the current playlist. Can be supplied in other requests to target a specific playlist version

tracks
object
A collection containing a link ( href ) to the Web API endpoint where full details of the playlist's tracks can be retrieved, along with the total number of tracks in the playlist. Note, a track object may be null. This can happen if a track is no longer available.

type
string
The object type: "playlist"

uri
string
The Spotify URI for the playlist.

endpoint
https://api.spotify.com/v1/me/playlists
limit
10
offset
5
Request sample

cURL

Wget

HTTPie

```bash
curl --request GET \
 --url https://api.spotify.com/v1/me/playlists \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z'
```

Response sample

```json
{
"href": "https://api.spotify.com/v1/me/shows?offset=0&limit=20",
"limit": 20,
"next": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"offset": 0,
"previous": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"total": 4,
"items": [
{
"collaborative": false,
"description": "string",
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"name": "string",
"owner": {
"external_urls": {
"spotify": "string"
},
"href": "string",
"id": "string",
"type": "user",
"uri": "string",
"display_name": "string"
},
"public": false,
"snapshot_id": "string",
"tracks": {
"href": "string",
"total": 0
},
"type": "string",
"uri": "string"
}
]
}
Web API •
References / Playlists / Get User's Playlists
Get User's Playlists

OAuth 2.0
Get a list of the playlists owned or followed by a Spotify user.

Authorization scopes
playlist-read-private
playlist-read-collaborative
Request

GET
/users/{user_id}/playlists
user_id
string
Required
The user's Spotify user ID.

Example: smedjan
limit
integer
The maximum number of items to return. Default: 20. Minimum: 1. Maximum: 50.

Default: limit=20
Range: 0 - 50
Example: limit=10
offset
integer
The index of the first playlist to return. Default: 0 (the first object). Maximum offset: 100.000. Use with limit to get the next set of playlists.

Default: offset=0
Example: offset=5
Response
200
401
403
429
A paged set of playlists

href
string
Required
A link to the Web API endpoint returning the full result of the request

Example: "https://api.spotify.com/v1/me/shows?offset=0&limit=20"
limit
integer
Required
The maximum number of items in the response (as set in the query or by default).

Example: 20
next
string
Required
Nullable
URL to the next page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
offset
integer
Required
The offset of the items returned (as set in the query or by default)

Example: 0
previous
string
Required
Nullable
URL to the previous page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
total
integer
Required
The total number of items available to return.

Example: 4

items
array of SimplifiedPlaylistObject
Required
collaborative
boolean
true if the owner allows other users to modify the playlist.

description
string
The playlist description. Only returned for modified, verified playlists, otherwise null.

external_urls
object
Known external URLs for this playlist.

href
string
A link to the Web API endpoint providing full details of the playlist.

id
string
The Spotify ID for the playlist.

images
array of ImageObject
Images for the playlist. The array may be empty or contain up to three images. The images are returned by size in descending order. See Working with Playlists. Note: If returned, the source URL for the image (url) is temporary and will expire in less than a day.

name
string
The name of the playlist.

owner
object
The user who owns the playlist

public
boolean
The playlist's public/private status (if it is added to the user's profile): true the playlist is public, false the playlist is private, null the playlist status is not relevant. For more about public/private status, see Working with Playlists

snapshot_id
string
The version identifier for the current playlist. Can be supplied in other requests to target a specific playlist version

tracks
object
A collection containing a link ( href ) to the Web API endpoint where full details of the playlist's tracks can be retrieved, along with the total number of tracks in the playlist. Note, a track object may be null. This can happen if a track is no longer available.

type
string
The object type: "playlist"

uri
string
The Spotify URI for the playlist.

endpoint
https://api.spotify.com/v1/users/{user_id}/playlists
user_id
smedjan
limit
10
offset
5
Request sample

cURL

Wget

HTTPie

```bash
curl --request GET \
 --url https://api.spotify.com/v1/users/smedjan/playlists \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z'
```

Response sample

```json
{
"href": "https://api.spotify.com/v1/me/shows?offset=0&limit=20",
"limit": 20,
"next": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"offset": 0,
"previous": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"total": 4,
"items": [
{
"collaborative": false,
"description": "string",
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"name": "string",
"owner": {
"external_urls": {
"spotify": "string"
},
"href": "string",
"id": "string",
"type": "user",
"uri": "string",
"display_name": "string"
},
"public": false,
"snapshot_id": "string",
"tracks": {
"href": "string",
"total": 0
},
"type": "string",
"uri": "string"
}
]
}Web API •
References / Playlists / Create Playlist
Create Playlist

OAuth 2.0
Create a playlist for a Spotify user. (The playlist will be empty until you add tracks.) Each user is generally limited to a maximum of 11000 playlists.

Authorization scopes
playlist-modify-public
playlist-modify-private
Request

POST
/users/{user_id}/playlists
user_id
string
Required
The user's Spotify user ID.

Example: smedjan
Body application/json
supports free form additional properties
name
string
Required
The name for the new playlist, for example "Your Coolest Playlist". This name does not need to be unique; a user may have several playlists with the same name.

public
boolean
Defaults to true. The playlist's public/private status (if it should be added to the user's profile or not): true the playlist will be public, false the playlist will be private. To be able to create private playlists, the user must have granted the playlist-modify-private scope. For more about public/private status, see Working with Playlists

collaborative
boolean
Defaults to false. If true the playlist will be collaborative. Note: to create a collaborative playlist you must also set public to false. To create collaborative playlists you must have granted playlist-modify-private and playlist-modify-public scopes.

description
string
value for playlist description as displayed in Spotify Clients and in the Web API.

Response
201
401
403
429
A playlist

collaborative
boolean
true if the owner allows other users to modify the playlist.

description
string
Nullable
The playlist description. Only returned for modified, verified playlists, otherwise null.

external_urls
object
Known external URLs for this playlist.

spotify
string
The Spotify URL for the object.

href
string
A link to the Web API endpoint providing full details of the playlist.

id
string
The Spotify ID for the playlist.

images
array of ImageObject
Images for the playlist. The array may be empty or contain up to three images. The images are returned by size in descending order. See Working with Playlists. Note: If returned, the source URL for the image (url) is temporary and will expire in less than a day.

url
string
Required
The source URL of the image.

Example: "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228"
height
integer
Required
Nullable
The image height in pixels.

Example: 300
width
integer
Required
Nullable
The image width in pixels.

Example: 300
name
string
The name of the playlist.

owner
object
The user who owns the playlist

external_urls
object
Known public external URLs for this user.

href
string
A link to the Web API endpoint for this user.

id
string
The Spotify user ID for this user.

type
string
The object type.

Allowed values: "user"
uri
string
The Spotify URI for this user.

display_name
string
Nullable
The name displayed on the user's profile. null if not available.

public
boolean
The playlist's public/private status (if it is added to the user's profile): true the playlist is public, false the playlist is private, null the playlist status is not relevant. For more about public/private status, see Working with Playlists

snapshot_id
string
The version identifier for the current playlist. Can be supplied in other requests to target a specific playlist version

tracks
object
The tracks of the playlist.

href
string
Required
A link to the Web API endpoint returning the full result of the request

Example: "https://api.spotify.com/v1/me/shows?offset=0&limit=20"
limit
integer
Required
The maximum number of items in the response (as set in the query or by default).

Example: 20
next
string
Required
Nullable
URL to the next page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
offset
integer
Required
The offset of the items returned (as set in the query or by default)

Example: 0
previous
string
Required
Nullable
URL to the previous page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
total
integer
Required
The total number of items available to return.

Example: 4

items
array of PlaylistTrackObject
Required
type
string
The object type: "playlist"

uri
string
The Spotify URI for the playlist.

endpoint
https://api.spotify.com/v1/users/{user_id}/playlists
user_id
smedjan
Request body

```json
{
  "name": "New Playlist",
  "description": "New playlist description",
  "public": false
}
```

```json
{
  "name": "New Playlist",
  "description": "New playlist description",
  "public": false
}
```

Request sample

cURL

Wget

HTTPie

```bash
curl --request POST \
 --url https://api.spotify.com/v1/users/smedjan/playlists \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z' \
 --header 'Content-Type: application/json' \
 --data '{
"name": "New Playlist",
"description": "New playlist description",
"public": false
}'
```

Response sample

```json
{
"collaborative": false,
"description": "string",
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"name": "string",
"owner": {
"external_urls": {
"spotify": "string"
},
"href": "string",
"id": "string",
"type": "user",
"uri": "string",
"display_name": "string"
},
"public": false,
"snapshot_id": "string",
"tracks": {
"href": "https://api.spotify.com/v1/me/shows?offset=0&limit=20",
"limit": 20,
"next": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"offset": 0,
"previous": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"total": 4,
"items": [

```json
{
"added_at": "string",
"added_by": {
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"type": "user",
"uri": "string"
},
"is_local": false,
"track": {
"album": {
"album_type": "compilation",
"total_tracks": 9,
"available_markets": ["CA", "BR", "IT"],
"external_urls": {
"spotify": "string"
},
"href": "string",
"id": "2up3OPMp9Tb4dAKM2erWXQ",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"name": "string",
"release_date": "1981-12",
"release_date_precision": "year",
"restrictions": {
"reason": "market"
},
"type": "album",
"uri": "spotify:album:2up3OPMp9Tb4dAKM2erWXQ",
"artists": [

```json
{
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"name": "string",
"type": "artist",
"uri": "string"
}
]
},
"artists": [

```json
{
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"name": "string",
"type": "artist",
"uri": "string"
}
],
"available_markets": ["string"],
"disc_number": 0,
"duration_ms": 0,
"explicit": false,
"external_ids": {
"isrc": "string",
"ean": "string",
"upc": "string"
},
"external_urls": {
"spotify": "string"
},
"href": "string",
"id": "string",
"is_playable": false,
"linked_from": {
},
"restrictions": {
"reason": "string"
},
"name": "string",
"popularity": 0,
"preview_url": "string",
"track_number": 0,
"type": "track",
"uri": "string",
"is_local": false
}
}
]
},
"type": "string",
"uri": "string"
}Web API •
References / Playlists / Get Featured Playlists
Get Featured Playlists

OAuth 2.0
Deprecated
Get a list of Spotify featured playlists (shown, for example, on a Spotify player's 'Browse' tab).

Important policy note
Spotify data may not be transferred
Request

GET
/browse/featured-playlists
locale
string
The desired language, consisting of an ISO 639-1 language code and an ISO 3166-1 alpha-2 country code, joined by an underscore. For example: es_MX, meaning "Spanish (Mexico)". Provide this parameter if you want the category strings returned in a particular language.
Note: if locale is not supplied, or if the specified language is not available, the category strings returned will be in the Spotify default language (American English).

Example: locale=sv_SE
limit
integer
The maximum number of items to return. Default: 20. Minimum: 1. Maximum: 50.

Default: limit=20
Range: 0 - 50
Example: limit=10
offset
integer
The index of the first item to return. Default: 0 (the first item). Use with limit to get the next set of items.

Default: offset=0
Example: offset=5
Response
200
401
403
429
A paged set of playlists

message
string
The localized message of a playlist.

Example: "Popular Playlists"

playlists
object
href
string
Required
A link to the Web API endpoint returning the full result of the request

Example: "https://api.spotify.com/v1/me/shows?offset=0&limit=20"
limit
integer
Required
The maximum number of items in the response (as set in the query or by default).

Example: 20
next
string
Required
Nullable
URL to the next page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
offset
integer
Required
The offset of the items returned (as set in the query or by default)

Example: 0
previous
string
Required
Nullable
URL to the previous page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
total
integer
Required
The total number of items available to return.

Example: 4

items
array of SimplifiedPlaylistObject
Required
Request sample

cURL

Wget

HTTPie

```bash
curl --request GET \
 --url https://api.spotify.com/v1/browse/featured-playlists \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z'
```

Response sample

```json
{
"message": "Popular Playlists",
"playlists": {
"href": "https://api.spotify.com/v1/me/shows?offset=0&limit=20",
"limit": 20,
"next": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"offset": 0,
"previous": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"total": 4,
"items": [
{
"collaborative": false,
"description": "string",
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"name": "string",
"owner": {
"external_urls": {
"spotify": "string"
},
"href": "string",
"id": "string",
"type": "user",
"uri": "string",
"display_name": "string"
},
"public": false,
"snapshot_id": "string",
"tracks": {
"href": "string",
"total": 0
},
"type": "string",
"uri": "string"
}
]
}
}Web API •
References / Users / Follow Playlist
Follow Playlist

OAuth 2.0
Add the current user as a follower of a playlist.

Authorization scopes
playlist-modify-public
playlist-modify-private
Request

PUT
/playlists/{playlist_id}/followers
playlist_id
string
Required
The Spotify ID of the playlist.

Example: 3cEYpjA9oz9GiPac4AsH4n
Body application/json
supports free form additional properties
public
boolean
Defaults to true. If true the playlist will be included in user's public playlists (added to profile), if false it will remain private. For more about public/private status, see Working with Playlists

Response
200
401
403
429
Playlist followed

endpoint
https://api.spotify.com/v1/playlists/{playlist_id}/followers
playlist_id
3cEYpjA9oz9GiPac4AsH4n
Request body

```json
{
  "public": false
}
```

```json
{
  "public": false
}
```

Request sample

cURL

Wget

HTTPie

```bash
curl --request PUT \
 --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n/followers \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z' \
 --header 'Content-Type: application/json' \
 --data '{
"public": false
}'
```

Response sample
empty responseWeb API •
References / Users / Unfollow Playlist
Unfollow Playlist

OAuth 2.0
Remove the current user as a follower of a playlist.

Authorization scopes
playlist-modify-public
playlist-modify-private
Request

DELETE
/playlists/{playlist_id}/followers
playlist_id
string
Required
The Spotify ID of the playlist.

Example: 3cEYpjA9oz9GiPac4AsH4n
Response
200
401
403
429
Playlist unfollowed

endpoint
https://api.spotify.com/v1/playlists/{playlist_id}/followers
playlist_id
3cEYpjA9oz9GiPac4AsH4n
Request sample

cURL

Wget

HTTPie

```bash
curl --request DELETE \
 --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n/followers \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z'
```

Response sample
empty responseWeb API •
References / Users / Get Followed Artists
Get Followed Artists

OAuth 2.0
Get the current user's followed artists.

Authorization scopes
user-follow-read
Request

GET
/me/following
type
string
Required
The ID type: currently only artist is supported.

Allowed values: "artist"
Example: type=artist
after
string
The last artist ID retrieved from the previous request.

Example: after=0I2XqVXqHScXjHhk6AYYRe
limit
integer
The maximum number of items to return. Default: 20. Minimum: 1. Maximum: 50.

Default: limit=20
Range: 0 - 50
Example: limit=10
Response
200
401
403
429
A paged set of artists

artists
object
Required
href
string
A link to the Web API endpoint returning the full result of the request.

limit
integer
The maximum number of items in the response (as set in the query or by default).

next
string
URL to the next page of items. ( null if none)

cursors
object
The cursors used to find the next set of items.

total
integer
The total number of items available to return.

items
array of ArtistObject
endpoint
https://api.spotify.com/v1/me/following
type
artist
after
0I2XqVXqHScXjHhk6AYYRe
limit
10
Request sample

cURL

Wget

HTTPie

```bash
curl --request GET \
 --url 'https://api.spotify.com/v1/me/following?type=artist' \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z'
```

Response sample

```json
{
"artists": {
"href": "string",
"limit": 0,
"next": "string",
"cursors": {
"after": "string",
"before": "string"
},
```

"total": 0,
"items": [

```json
{
"external_urls": {
"spotify": "string"
},
```

"followers": {
"href": "string",
"total": 0
},
"genres": ["Prog rock", "Grunge"],
"href": "string",
"id": "string",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"name": "string",
"popularity": 0,
"type": "artist",
"uri": "string"
}
]
}
}Web API •
References / Users / Follow Artists or Users
Follow Artists or Users

OAuth 2.0
Add the current user as a follower of one or more artists or other Spotify users.

Authorization scopes
user-follow-modify
Request

PUT
/me/following
type
string
Required
The ID type.

Allowed values: "artist", "user"
Example: type=artist
ids
string
Required
A comma-separated list of the artist or the user Spotify IDs. A maximum of 50 IDs can be sent in one request.

Example: ids=2CIMQHirSU0MQqyYHq0eOx,57dN52uHvrHOxijzpIgu3E,1vCWHaC5f2uS3yhpwWbIA6
Body application/json
supports free form additional properties
ids
array of strings
Required
A JSON array of the artist or user Spotify IDs. For example: {ids:["74ASZWbe4lXaubB36ztrGX", "08td7MxkoHQkXnWAYD8d6Q"]}. A maximum of 50 IDs can be sent in one request. Note: if the ids parameter is present in the query string, any IDs listed here in the body will be ignored.

Response
204
401
403
429
Artist or user followed

endpoint
https://api.spotify.com/v1/me/following
type
artist
ids
2CIMQHirSU0MQqyYHq0eOx,57dN52uHvrHOxijzpIgu3E,1vCWHaC5f2uS3yhpwWbIA6
Request body

```json
{
"ids": [
"string"
]
```

}

```json
{
"ids": [
"string"
]
```

}
Request sample

cURL

Wget

HTTPie

```bash
curl --request PUT \
 --url 'https://api.spotify.com/v1/me/following?type=artist&ids=2CIMQHirSU0MQqyYHq0eOx%2C57dN52uHvrHOxijzpIgu3E%2C1vCWHaC5f2uS3yhpwWbIA6' \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z' \
 --header 'Content-Type: application/json' \
 --data '{
"ids": [
"string"
]
}'
```

Response sample
empty responseWeb API •
References / Users / Check If User Follows Artists or Users
Check If User Follows Artists or Users

OAuth 2.0
Check to see if the current user is following one or more artists or other Spotify users.

Authorization scopes
user-follow-read
Request

GET
/me/following/contains
type
string
Required
The ID type: either artist or user.

Allowed values: "artist", "user"
Example: type=artist
ids
string
Required
A comma-separated list of the artist or the user Spotify IDs to check. For example: ids=74ASZWbe4lXaubB36ztrGX,08td7MxkoHQkXnWAYD8d6Q. A maximum of 50 IDs can be sent in one request.

Example: ids=2CIMQHirSU0MQqyYHq0eOx,57dN52uHvrHOxijzpIgu3E,1vCWHaC5f2uS3yhpwWbIA6
Response
200
401
403
429
Array of booleans

Example: [false,true]
endpoint
https://api.spotify.com/v1/me/following/contains
type
artist
ids
2CIMQHirSU0MQqyYHq0eOx,57dN52uHvrHOxijzpIgu3E,1vCWHaC5f2uS3yhpwWbIA6
Request sample

cURL

Wget

HTTPie

```bash
curl --request GET \
 --url 'https://api.spotify.com/v1/me/following/contains?type=artist&ids=2CIMQHirSU0MQqyYHq0eOx%2C57dN52uHvrHOxijzpIgu3E%2C1vCWHaC5f2uS3yhpwWbIA6' \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z'
```

Response sample

```json
[false, true]Web API •
References / Users / Check if Current User Follows Playlist
Check if Current User Follows Playlist

OAuth 2.0
Check to see if the current user is following a specified playlist.

Request

GET
/playlists/{playlist_id}/followers/contains
playlist_id
string
Required
The Spotify ID of the playlist.

Example: 3cEYpjA9oz9GiPac4AsH4n
ids
string
Deprecated A single item list containing current user's Spotify Username. Maximum: 1 id.

Example: ids=jmperezperez
Response
200
401
403
429
Array of boolean, containing a single boolean

Example: [true]
endpoint
https://api.spotify.com/v1/playlists/{playlist_id}/followers/contains
playlist_id
3cEYpjA9oz9GiPac4AsH4n
ids
jmperezperez
Request sample

cURL

Wget

HTTPie
curl --request GET \
 --url https://api.spotify.com/v1/playlists/3cEYpjA9oz9GiPac4AsH4n/followers/contains \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z'
Response sample
[true]Web API •
References / Users / Unfollow Artists or Users
Unfollow Artists or Users

OAuth 2.0
Remove the current user as a follower of one or more artists or other Spotify users.

Authorization scopes
user-follow-modify
Request

DELETE
/me/following
type
string
Required
The ID type: either artist or user.

Allowed values: "artist", "user"
Example: type=artist
ids
string
Required
A comma-separated list of the artist or the user Spotify IDs. For example: ids=74ASZWbe4lXaubB36ztrGX,08td7MxkoHQkXnWAYD8d6Q. A maximum of 50 IDs can be sent in one request.

Example: ids=2CIMQHirSU0MQqyYHq0eOx,57dN52uHvrHOxijzpIgu3E,1vCWHaC5f2uS3yhpwWbIA6
Body application/json
supports free form additional properties
ids
array of strings
A JSON array of the artist or user Spotify IDs. For example: {ids:["74ASZWbe4lXaubB36ztrGX", "08td7MxkoHQkXnWAYD8d6Q"]}. A maximum of 50 IDs can be sent in one request. Note: if the ids parameter is present in the query string, any IDs listed here in the body will be ignored.

Response
204
401
403
429
Artist or user unfollowed

endpoint
https://api.spotify.com/v1/me/following
type
artist
ids
2CIMQHirSU0MQqyYHq0eOx,57dN52uHvrHOxijzpIgu3E,1vCWHaC5f2uS3yhpwWbIA6
Request body
{
"ids": [
"string"
]
```

}

```json
{
"ids": [
"string"
]
```

}
Request sample

cURL

Wget

HTTPie

```bash
curl --request DELETE \
 --url 'https://api.spotify.com/v1/me/following?type=artist&ids=2CIMQHirSU0MQqyYHq0eOx%2C57dN52uHvrHOxijzpIgu3E%2C1vCWHaC5f2uS3yhpwWbIA6' \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z' \
 --header 'Content-Type: application/json' \
 --data '{
"ids": [
"string"
]
}'
```

Response sample
empty response
