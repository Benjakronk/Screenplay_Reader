// Where the Faaglarna cloud backend lives.
//
// Leave this EMPTY and the app behaves exactly as it always has: the Python
// server when one is running behind the page, otherwise the offline
// IndexedDB build. Nothing about signing in appears at all.
//
// Set it to the API's origin — no trailing slash, no /api suffix — to enable
// accounts and live collaboration. For this project that is:
//
//     window.FAAGLARNA_CLOUD = 'https://api-faaglarna.lektorensrud.no';
//
// This is the ONE place the domain is configured. The collaboration WebSocket
// URL is derived from it (https -> wss, + /collab), so there is nothing else
// to keep in sync.
//
// SAME ORIGIN. The frontend is served from the same host as the API, so this
// names the page's own origin. That means no cross-origin requests, no
// preflights, and no CORS to get wrong — the API's CORS middleware stays in
// place but never has to do anything.
//
// It is written out in full rather than derived from location.origin so that a
// copy of the app served from anywhere else — the GitHub Pages build, or a file
// opened locally — still talks to the real backend instead of to itself.
window.FAAGLARNA_CLOUD = 'https://faaglarna.lektorensrud.no';
