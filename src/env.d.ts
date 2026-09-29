/// <reference types="vite/client" />

/** True only for the `vite build --mode e2e` bundle (production build + scripted test hooks). */
declare const __E2E__: boolean;
/** Semantic game version baked into saves. */
declare const __GAME_VERSION__: string;
