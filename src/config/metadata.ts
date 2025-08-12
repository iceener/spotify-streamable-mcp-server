export const serverMetadata = {
  title: 'Spotify Music',
  instructions: `Use these tools to find music, get the current player status, control and transfer playback, and manage playlists and saved songs.

Tools
- search_catalog: Find songs, artists, albums, or playlists. Inputs: queries[], types[album|artist|playlist|track], optional market (2-letter), limit (1-50), offset (0-1000), include_external['audio']. Returns per-query ordered items (slim fields like id, name, uri; tracks include artists).
- player_status: Read current player, available devices, queue, and current track. Use this first to discover device_id before control.
- spotify_control: Batch control with operations[]. action ∈ {play,pause,next,previous,seek,volume,shuffle,repeat,transfer,queue}. Provide matching params (position_ms, volume_percent, repeat, device_id, context_uri/uris, offset, queue_uri, transfer_play). Optional parallel=true runs operations concurrently. The tool automatically fetches player status after actions and reports whether playback is active, the target device, and current volume. Before transfer, call player_status to pick a device; if no active device exists, ask the user to open Spotify.
- spotify_playlist: Manage playlists. action ∈ {list_user,get,items,create,update_details,add_items,remove_items,reorder_items}.
- spotify_library: Manage saved songs. action ∈ {tracks_get,tracks_add,tracks_remove,tracks_contains}.

 Notes
 - If a call returns Unauthorized, ask the user to authenticate and retry.
 - Prefer small limits and minimal polling unless asked to do otherwise.
 - Use player_status to pick device_id before control. If no active device is found, prompt the user to open Spotify and/or transfer to a listed device.
- After control actions, the tool includes a concise status. For full details, you can still call player_status. If not playing, ask the user to open Spotify or transfer to a listed device.`,
} as const;

export const toolsMetadata = {
  search_catalog: {
    name: 'search_catalog',
    title: 'Find Music (Catalog Search)',
    description:
      "Search songs, artists, albums, and playlists. Inputs: queries[], types[album|artist|playlist|track], optional market(2 letters), limit(1-50), offset(0-1000), include_external['audio']. Returns ordered items per query.",
  },
  player_status: {
    name: 'player_status',
    title: 'Player Status',
    description:
      'Read the current player state, devices, queue, and current track. Optional include[] selects any of: player, devices, queue, current_track. Use this to learn device_id before control.',
  },
  spotify_control: {
    name: 'spotify_control',
    title: 'Control Spotify Playback',
    description:
      "Control Spotify playback: play, pause, next/previous, seek, shuffle, repeat, volume, transfer, and queue. Accepts a batch of operations and returns per-operation results. Optional parallel=true runs operations concurrently.\n\nUsage notes:\n- To play a specific track from a playlist, set 'context_uri' to the playlist URI (e.g., 'spotify:playlist:...') and set 'offset' to either { position: <zero-based index> } or { uri: 'spotify:track:...' }.\n- Do not provide 'uris' together with 'context_uri' in the same play operation.\n- Use the 'player_status' tool first to get a 'device_id' to target.\n- After issuing play/transfer, call 'player_status' to confirm playback and target device.",
  },
  spotify_playlist: {
    name: 'spotify_playlist',
    title: 'Playlists: Create, Edit, and Browse',
    description:
      "Manage playlists for the signed-in user: list your playlists, read one, list its items, create a new one, update details, add or remove items, and reorder items.\n\nNotes:\n- The 'items' action returns playlist tracks annotated with a zero-based 'position' and includes 'playlist_uri' so the model can start playback at an exact track using 'spotify_control' → action 'play' with { context_uri: playlist_uri, offset: { position } }.",
  },
  spotify_library: {
    name: 'spotify_library',
    title: 'Library: Saved Songs',
    description:
      'Manage saved songs: list, add, remove, and check if songs are saved for the current user.',
  },
} as const;
