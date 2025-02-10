// cheap type definitions for Bun
// because installing bun-types causes a lot of issues
// elsewhere around the codebase. proper solution is
// a pretty big refactor

declare namespace Bun {
  export interface Server {
    url: URL
    reload: (options: Bun.ServeOptions) => void
  }

  export interface ServeOptions {
    port: number
    hostname: string
    fetch: (request: Request, server: Bun.Server) => Promise<Response>
    static: Record<string, Response>
  }

  export interface Glob {
    scan(options: { dot: boolean; cwd: string }): AsyncIterable<string>
  }
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
declare const Bun: {
  serve: (options: Bun.ServeOptions) => Bun.Server
  file: (path: string) => Blob
  Glob: {
    new (pattern: string): Bun.Glob
  }
  readableStreamToText: (stream: ReadableStream<Uint8Array>) => Promise<string>
}
