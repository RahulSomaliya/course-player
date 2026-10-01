// scripts/build-sea.sh passes esbuild --define:__COURSE_PLAYER_VERSION__='"<pkg version>+<UTC stamp>"'.
// Under tsx/vitest nothing defines it, so the typeof guard (safe on an undeclared global) yields "dev".
declare const __COURSE_PLAYER_VERSION__: string | undefined;

export const VERSION: string = typeof __COURSE_PLAYER_VERSION__ === 'string' ? __COURSE_PLAYER_VERSION__ : 'dev';
