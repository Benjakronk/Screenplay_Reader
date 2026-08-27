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
// LEAVE THIS EMPTY until the backend is actually up. The moment it is set, the
// app offers a sign-in prompt on every visit — which is just noise if there is
// nothing behind it yet. See docs/TODO.md step 11.
window.FAAGLARNA_CLOUD = '';
