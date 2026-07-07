// ── DOM Element References ────────────────────────────────────────────────
// Note: type="module" scripts are auto-deferred, so DOM is ready at eval time
export const el = {
  listHeaders:       document.getElementById("listHeaders"),
  headerCols:        document.querySelectorAll(".header-col[data-sort]"),
  trackGrid:         document.getElementById("trackGrid"),
  layoutToggleButton: document.querySelector("#layoutToggleButton"),

  // Navigation
  navItems:          document.querySelectorAll(".nav-item[data-view]"),
  searchInput:       document.querySelector("#searchInput"),
  sidebarPlaylistList: document.querySelector("#sidebarPlaylistList"),

  // Main View
  backButton:        document.querySelector("#backButton"),
  importPanel:       document.querySelector("#importPanel"),
  contentScroll:     document.querySelector("#contentScroll"),
  viewTitle:         document.querySelector("#viewTitle"),

  // Import Sheet
  importSmallButton:  document.querySelector("#importSmallButton"),
  importMainButton:   document.querySelector("#importMainButton"),
  importSheet:        document.querySelector("#importSheet"),
  folderInputSheet:   document.querySelector("#folderInputSheet"),
  importButtonSheet:  document.querySelector("#importButtonSheet"),
  importStatusSheet:  document.querySelector("#importStatusSheet"),
  importSheetClose:   document.querySelector("#importSheetClose"),
  sidebarImportButton: document.querySelector("#sidebarImportButton"),
  clearCacheButton: document.querySelector("#clearCacheButton"),

  // Player Pill
  playerPill:    document.querySelector("#playerPill"),
  trackTitle:    document.querySelector("#trackTitle"),
  trackArtist:   document.querySelector("#trackArtist"),
  coverImage:    document.querySelector("#coverImage"),

  // Transport
  shuffleButton: document.querySelector("#shuffleButton"),
  prevButton:    document.querySelector("#prevButton"),
  playButton:    document.querySelector("#playButton"),
  nextButton:    document.querySelector("#nextButton"),
  repeatButton:  document.querySelector("#repeatButton"),
  moreButton:    document.querySelector("#moreButton"),
  queueButton:   document.querySelector("#queueButton"),
  codecDisplay:  document.querySelector("#codecDisplay"),
  bitrateDisplay:document.querySelector("#bitrateDisplay"),

  // Scrubber
  currentTime:      document.querySelector("#currentTime"),
  timeRemaining:    document.querySelector("#timeRemaining"),
  scrubberBar:      document.querySelector("#scrubberBar"),
  scrubberProgress: document.querySelector("#scrubberProgress"),
  scrubberHandle:   document.querySelector("#scrubberHandle"),

  // Volume
  muteBtn:       document.querySelector("#muteBtn"),
  volScrubberBg: document.querySelector("#volScrubberBg"),
  volProgress:   document.querySelector("#volProgress"),

  // Queue Panel
  queuePanel:       document.querySelector("#queuePanel"),
  queueList:        document.querySelector("#queueList"),
  queueCount:       document.querySelector("#queueCount"),
  queueClearButton: document.querySelector("#queueClearButton"),
  queueCloseButton: document.querySelector("#queueCloseButton"),
  playerPlaylistButton: document.querySelector("#playerPlaylistButton"),

  // Misc
  contextMenu: document.querySelector("#contextMenu"),
  playlistPicker: document.querySelector("#playlistPicker"),
  playlistPickerTrack: document.querySelector("#playlistPickerTrack"),
  playlistPickerList: document.querySelector("#playlistPickerList"),
  playlistPickerClose: document.querySelector("#playlistPickerClose"),
  playlistPickerDone: document.querySelector("#playlistPickerDone"),
  playlistPickerNew: document.querySelector("#playlistPickerNew"),
  audio:       document.querySelector("#audio")
};
