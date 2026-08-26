// Where the Faaglarna cloud backend lives.
//
// Leave this EMPTY and the app behaves exactly as it always has: the Python
// server when one is running behind the page, otherwise the offline
// IndexedDB build. Nothing about signing in appears at all.
//
// Set it to the API's origin — no trailing slash, no /api suffix — to enable
// accounts and live collaboration:
//
//     window.FAAGLARNA_CLOUD = 'https://api.example.no';
//
// This is the ONE place the domain is configured. The collaboration WebSocket
// URL is derived from it (https -> wss, + /collab), so there is nothing else
// to keep in sync.
window.FAAGLARNA_CLOUD = '';
