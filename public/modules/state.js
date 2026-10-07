import { getStorage } from "./storage.js";

export const DEFAULT_COVER = "/assets/default-cover.png";
const savedSortField = getStorage("amp-sort-field", "none");
const savedSortDir = getStorage("amp-sort-dir", "asc");

export const state = {
  tracks: [],
  trackIds: [],
  libraryReady: false,
  libraryRevision: 0,
  libraryPage: { key: '', tracks: [], groups: [], total: 0, loading: false, error: '' },
  facets: { genre: [], year: [], codec: [] },
  playlists: [],
  selectedTrackId: null,
  currentTrackId: null,
  queue: [],
  queueIndex: -1,
  sortField: ["none", "title", "album", "duration"].includes(savedSortField) ? savedSortField : "none",
  sortDir: savedSortDir === "desc" ? "desc" : "asc",
  activeView: "home",
  activePlaylistId: null,
  activeGroup: null,
  search: "",
  layout: getStorage("amp-layout") === "list" ? "list" : "grid",
  queueOpen: false,
  shuffle: false,
  repeat: "none",
  busy: false,
  history: [],
  searchReturn: null,
  playbackError: "",
  buffering: false,
  recentIds: [],
  gridPageSize: 150,
  gridOffset: 0,
  queuePage: 0,
  filters: { genre: "", year: "", codec: "", duration: "", favorite: false, recentlyPlayed: false },
  librarySources: []
};
