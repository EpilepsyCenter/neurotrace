/// <reference types="vite/client" />

declare module '*.md?raw' {
  const content: string
  export default content
}

/** Injected by Vite's ``define`` (see vite.config.ts). Read from the
 *  root package.json's ``version`` field at build time. */
declare const __APP_VERSION__: string
