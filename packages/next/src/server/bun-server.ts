import * as nextEnv from '@next/env'
import { join } from 'node:path'
import type { ParsedUrlQuery } from 'querystring'
import {
  APP_PATHS_MANIFEST,
  CLIENT_PUBLIC_FILES_PATH,
  MIDDLEWARE_MANIFEST,
  NEXT_FONT_MANIFEST,
  PRERENDER_MANIFEST,
  ROUTES_MANIFEST,
} from '../api/constants'
import type { PrerenderManifest } from '../build'
import * as Log from '../build/output/log'
import type { MiddlewareManifest } from '../build/webpack/plugins/middleware-plugin'
import type { NextFontManifest } from '../build/webpack/plugins/next-font-manifest-plugin'
import type { PagesManifest } from '../build/webpack/plugins/pages-manifest-plugin'
import { buildCustomRoute } from '../lib/build-custom-route'
import type { Rewrite } from '../lib/load-custom-routes'
import type { DeepReadonly } from '../shared/lib/deep-readonly'
import {
  type MiddlewareRouteMatch,
  getMiddlewareRouteMatcher,
} from '../shared/lib/router/utils/middleware-route-matcher'
import { removeTrailingSlash } from '../shared/lib/router/utils/remove-trailing-slash'
import {
  type AppSharedContext,
  renderToHTMLOrFlight,
} from './app-render/app-render'
import { BunNextRequest, BunNextResponse } from './base-http/bun'
import BaseServer, {
  type FindComponentsResult,
  type LoadedRenderOpts,
  type MiddlewareRoutingItem,
  type NextEnabledDirectories,
  type NormalizedRouteManifest,
  type RouteHandler,
  NoFallbackError,
} from './base-server'
import type { NextConfig } from './config'
import { generateETag } from './lib/etag'
import { IncrementalCache } from './lib/incremental-cache'
import type { ExpireTime, Revalidate } from './lib/revalidate'
import { loadComponents } from './load-components'
import { loadManifest } from './load-manifest'
import type RenderResult from './render-result'
import type { AppPageRenderResultMetadata } from './render-result'
import {
  type NextParsedUrlQuery,
  type NextUrlWithParsedQuery,
  addRequestMeta,
  getRequestMeta,
} from './request-meta'
import type { Params } from './request/params'
import { getMaybePagePath } from './require'
import ResponseCache, { type ResponseCacheBase } from './response-cache'
import type { PagesAPIRouteMatch } from './route-matches/pages-api-route-match'

export interface BunNextServerOptions {
  /**
   * Object containing the configuration next.config.js
   */
  conf: NextConfig

  //////////////////////////////////

  /**
   * Must be an absolute path
   */
  distDir: string
  buildId: string
  publicDir: string
  appPathsManifest: PagesManifest | DeepReadonly<PagesManifest>
  nextFontManifest: NextFontManifest | DeepReadonly<NextFontManifest>
  middlewareManifest: MiddlewareManifest | DeepReadonly<MiddlewareManifest>
  prerenderManifest: PrerenderManifest | DeepReadonly<PrerenderManifest>
  appSharedContext: AppSharedContext | DeepReadonly<AppSharedContext>
  interceptionRouteRewrites: Rewrite[]
}

// cheap type definitions for Bun
// because installing bun-types causes a lot of issues
// elsewhere around the codebase. proper solution is
// a really huge refactor
declare const Bun: {
  serve: (options: {
    port: number
    hostname: string
    static: Record<string, string>
    fetch: (request: Request) => Promise<Response>
  }) => {
    url: string
  }
  file: (path: string) => {
    text: () => Promise<string>
  }
}

export class BunNextServer extends BaseServer<
  BunNextServerOptions,
  BunNextRequest,
  BunNextResponse
> {
  private static readonly MiddlewareMatcherCache = new WeakMap<
    MiddlewareManifest['middleware'][string],
    MiddlewareRouteMatch
  >()

  public static async start({
    conf,
    dir,
    port,
    hostname,
    staticAssets = {},
  }: {
    conf: NextConfig
    /**
     * The directory where server.js exists and also the .next folder
     */
    dir: string
    port: number
    hostname: string
    staticAssets?: {}
  }) {
    const BUILD_ID = await Bun.file(join(dir, '.next', 'BUILD_ID')).text()

    const appPathsManifest = loadManifest<PagesManifest>(
      join(dir, '.next', 'server', APP_PATHS_MANIFEST)
    )
    const nextFontManifest = loadManifest<NextFontManifest>(
      join(dir, '.next', 'server', NEXT_FONT_MANIFEST)
    )
    const middlewareManifest = loadManifest<MiddlewareManifest>(
      join(dir, '.next', 'server', MIDDLEWARE_MANIFEST)
    )

    const prerenderManifest = loadManifest<PrerenderManifest>(
      join(dir, '.next', PRERENDER_MANIFEST)
    )

    const server = new BunNextServer({
      conf,
      distDir: join(dir, '.next'),
      buildId: BUILD_ID,
      publicDir: CLIENT_PUBLIC_FILES_PATH,

      appPathsManifest,
      nextFontManifest,
      middlewareManifest,
      prerenderManifest,

      interceptionRouteRewrites: [],

      appSharedContext: {
        buildId: BUILD_ID,
      },
    })

    const handler = server.getRequestHandler()

    const bunServer = Bun.serve({
      port,
      hostname,
      static: staticAssets,

      fetch: async (rawRequest) => {
        const url = new URL(rawRequest.url)

        const request = new BunNextRequest(url, rawRequest)
        const response = new BunNextResponse()

        await handler(request, response)

        return response.toResponse()
      },
    })

    return bunServer
  }

  private static getMiddlewareMatcher(
    info: MiddlewareManifest['middleware'][string]
  ): MiddlewareRouteMatch {
    const stored = BunNextServer.MiddlewareMatcherCache.get(info)
    if (stored) {
      return stored
    }

    if (!Array.isArray(info.matchers)) {
      throw new Error(
        `Invariant: invalid matchers for middleware ${JSON.stringify(info)}`
      )
    }

    const matcher = getMiddlewareRouteMatcher(info.matchers)
    BunNextServer.MiddlewareMatcherCache.set(info, matcher)
    return matcher
  }

  public constructor(options: BunNextServerOptions) {
    super(options)
  }

  protected getPublicDir(): string {
    return this.serverOptions.publicDir
  }

  protected getHasStaticDir(): boolean {
    return true
  }

  protected getPagesManifest(): PagesManifest | undefined {
    return undefined // Bun server only works with app dir (for now..?)
  }

  protected getAppPathsManifest(): PagesManifest {
    return this.serverOptions.appPathsManifest
  }

  protected getBuildId(): string {
    return this.buildId
  }

  protected getinterceptionRoutePatterns(): RegExp[] {
    return (
      this.serverOptions.interceptionRouteRewrites?.map(
        (rewrite) => new RegExp(buildCustomRoute('rewrite', rewrite).regex)
      ) ?? []
    )
  }

  protected getEnabledDirectories(): NextEnabledDirectories {
    return { pages: false, app: true }
  }

  protected async findPageComponents(options: {
    page: string
    query: NextParsedUrlQuery
    params: Params
    isAppPath: boolean
    sriEnabled?: boolean
    appPaths?: ReadonlyArray<string> | null
    shouldEnsure?: boolean
    url?: string
  }): Promise<FindComponentsResult | null> {
    const result = await loadComponents({
      distDir: this.serverOptions.distDir,
      page: options.page,
      isAppPath: true,
      isDev: false,
      sriEnabled: false,
    })

    if (!result) {
      return null
    }

    return {
      query: {
        ...(options.query || {}),
        ...(options.params || {}),
      },
      components: result,
    }
  }

  protected getPrerenderManifest() {
    return this.serverOptions.prerenderManifest
  }

  protected getNextFontManifest(): DeepReadonly<NextFontManifest> {
    return this.serverOptions.nextFontManifest
  }

  protected attachRequestMeta(
    req: BunNextRequest,
    parsedUrl: NextUrlWithParsedQuery
  ): void {
    addRequestMeta(req, 'initQuery', { ...parsedUrl.query })
  }

  protected async hasPage(pathname: string): Promise<boolean> {
    return !!getMaybePagePath(
      pathname,
      this.distDir,
      this.nextConfig.i18n?.locales,
      true
    )
  }

  private static readonly byteLengthEncoder = new TextEncoder()
  private static fastByteLength(str: string): number {
    return BunNextServer.byteLengthEncoder.encode(str).buffer.byteLength
  }

  protected async sendRenderResult(
    _req: BunNextRequest,
    res: BunNextResponse,
    options: {
      result: RenderResult
      type: 'html' | 'json' | 'rsc'
      generateEtags: boolean
      poweredByHeader: boolean
      revalidate: Revalidate | undefined
      expireTime: ExpireTime | undefined
    }
  ): Promise<void> {
    console.log('sendRenderResult', options.poweredByHeader)

    res.setHeader('X-Edge-Runtime', '1')

    // Add necessary headers.
    // @TODO: Share the isomorphic logic with server/send-payload.ts.
    if (options.poweredByHeader && options.type === 'html') {
      res.setHeader('X-Powered-By', 'Next.js with Bun')
    }

    if (!res.getHeader('Content-Type')) {
      res.setHeader(
        'Content-Type',
        options.result.contentType
          ? options.result.contentType
          : options.type === 'json'
            ? 'application/json'
            : 'text/html; charset=utf-8'
      )
    }

    let promise: Promise<void> | undefined
    if (options.result.isDynamic) {
      promise = options.result.pipeTo(res.writable)
    } else {
      const payload = options.result.toUnchunkedString()
      res.setHeader(
        'Content-Length',
        String(BunNextServer.fastByteLength(payload))
      )

      if (options.generateEtags) {
        res.setHeader('ETag', generateETag(payload))
      }

      res.body(payload)
    }

    res.send()

    // If we have a promise, wait for it to resolve.
    if (promise) await promise
  }

  protected async runApi(
    _req: BunNextRequest,
    _res: BunNextResponse,
    _query: ParsedUrlQuery,
    _match: PagesAPIRouteMatch
  ): Promise<boolean> {
    const msg = [
      "runApi() is currently unsupported in Bun's Next.js server.",
      'This is likely a sign you are misusing the BunNextServer class.',
      "Please consult the docs to understand more about how Bun's Next server works",
    ].join('\n')

    console.warn(new Error(msg))

    return true
  }

  protected async getIncrementalCache({
    requestHeaders,
  }: {
    requestHeaders: Record<string, undefined | string | string[]>
    requestProtocol: 'http' | 'https'
  }): Promise<IncrementalCache> {
    const dev = !!this.renderOpts.dev
    // incremental-cache is request specific
    // although can have shared caches in module scope
    // per-cache  r
    return new IncrementalCache({
      dev,
      requestHeaders,
      dynamicIO: Boolean(this.nextConfig.experimental.dynamicIO),
      requestProtocol: 'https',
      allowedRevalidateHeaderKeys:
        this.nextConfig.experimental.allowedRevalidateHeaderKeys,
      minimalMode: this.minimalMode,
      fetchCacheKeyPrefix: this.nextConfig.experimental.fetchCacheKeyPrefix,
      maxMemoryCacheSize: this.nextConfig.cacheMaxMemorySize,
      flushToDisk: false,
      CurCacheHandler: null as never, // TODO?
      getPrerenderManifest: () => this.getPrerenderManifest(),
    })
  }

  protected getResponseCache(): ResponseCacheBase {
    return new ResponseCache(this.minimalMode)
  }

  protected loadEnvConfig({
    dev,
    forceReload,
  }: {
    dev: boolean
    forceReload?: boolean
  }): void {
    nextEnv.loadEnvConfig(this.dir, dev, Log, forceReload)
  }

  protected async handleUpgrade(): Promise<void> {
    const msg = [
      "handleUpgrade() is unsupported in Bun's Next.js server.",
      'This is likely a sign you are misusing the BunNextServer class.',
      "Please consult the docs to understand more about how Bun's Next server works",
    ].join('\n')

    console.warn(new Error(msg))
  }

  protected getMiddlewareManifest() {
    return this.serverOptions.middlewareManifest
  }

  protected getMiddleware(): MiddlewareRoutingItem | undefined {
    const manifest = this.getMiddlewareManifest()
    const middleware = manifest?.middleware?.['/']

    if (!middleware) {
      return
    }

    return {
      match: BunNextServer.getMiddlewareMatcher(
        middleware as MiddlewareManifest['middleware'][string]
      ),
      page: '/',
    }
  }

  protected async getFallbackErrorComponents() {
    const msg = [
      "getFallbackErrorComponents() is unsupported in Bun's Next.js server.",
      'This is likely a sign you are misusing the BunNextServer class.',
      "Please consult the docs to understand more about how Bun's Next server works",
    ].join('\n')

    console.warn(new Error(msg))

    return null
  }

  protected getRoutesManifest(): NormalizedRouteManifest {
    const manifest = loadManifest(join(this.distDir, ROUTES_MANIFEST)) as any

    let rewrites = manifest.rewrites ?? {
      beforeFiles: [],
      afterFiles: [],
      fallback: [],
    }

    if (Array.isArray(rewrites)) {
      rewrites = {
        beforeFiles: [],
        afterFiles: rewrites,
        fallback: [],
      }
    }

    return { ...manifest, rewrites }
  }

  protected async renderHTML(
    req: BunNextRequest,
    res: BunNextResponse,
    pathname: string,
    query: NextParsedUrlQuery,
    renderOpts: LoadedRenderOpts
  ): Promise<RenderResult<AppPageRenderResultMetadata>> {
    console.log('renderHTML')

    const result = await renderToHTMLOrFlight(
      req,
      res,
      pathname,
      query,
      null,
      renderOpts,
      undefined,
      false,
      this.serverOptions.appSharedContext
    )

    console.log('renderHTML', result)

    return result
  }

  public getRenderHTMLFn() {
    return this.renderHTML
  }

  protected handleCatchallRenderRequest: RouteHandler<
    BunNextRequest,
    BunNextResponse
  > = async (req, res, parsedUrl) => {
    let { pathname, query } = parsedUrl
    if (!pathname) {
      throw new Error('pathname is undefined')
    }

    // // interpolate query information into page for dynamic route
    // // so that rewritten paths are handled properly
    // const normalizedPage = this.serverOptions.webServerConfig.pathname;

    // if (pathname !== normalizedPage) {
    // 	pathname = normalizedPage;

    // 	if (isDynamicRoute(pathname)) {
    // 		const routeRegex = getNamedRouteRegex(pathname, false);
    // 		const dynamicRouteMatcher = getRouteMatcher(routeRegex);
    // 		const defaultRouteMatches = dynamicRouteMatcher(pathname) as NextParsedUrlQuery;
    // 		const paramsResult = normalizeDynamicRouteParams(
    // 			query,
    // 			false,
    // 			routeRegex,
    // 			defaultRouteMatches,
    // 		);
    // 		const normalizedParams = paramsResult.hasValidParams ? paramsResult.params : query;

    // 		pathname = interpolateDynamicPath(pathname, normalizedParams, routeRegex);
    // 		normalizeVercelUrl(req, true, Object.keys(routeRegex.routeKeys), true, routeRegex);
    // 	}
    // }

    // next.js core assumes page path without trailing slash
    pathname = removeTrailingSlash(pathname)

    if (this.i18nProvider) {
      const { detectedLocale } = this.i18nProvider.analyze(pathname)

      if (detectedLocale) {
        addRequestMeta(req, 'locale', detectedLocale)
      }
    }

    const bubbleNoFallback = getRequestMeta(req, 'bubbleNoFallback')

    try {
      await this.render(req, res, pathname, query, parsedUrl, true)

      return true
    } catch (err) {
      if (err instanceof NoFallbackError && bubbleNoFallback) {
        return false
      }
      throw err
    }
  }
}
