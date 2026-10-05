import { playerStatus } from './player-status';
import { searchCatalog } from './search-catalog';
import { spotifyControl } from './spotify-control';
import { spotifyLibrary } from './spotify-library';
import { spotifyPlaylist } from './spotify-playlist';

/** Every tool, in the order clients list them. The order is part of the published contract. */
export const tools = [playerStatus, searchCatalog, spotifyControl, spotifyPlaylist, spotifyLibrary];
