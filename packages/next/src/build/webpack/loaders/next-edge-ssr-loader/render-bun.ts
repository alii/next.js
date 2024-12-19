import type { NextConfigComplete } from '../../../../server/config-shared'

import type { BuildManifest } from '../../../../server/get-page-files'
import type {
  DynamicCssManifest,
  ReactLoadableManifest,
} from '../../../../server/load-components'
import type { AppType, DocumentType } from '../../../../shared/lib/utils'
import type { ClientReferenceManifest } from '../../plugins/flight-manifest-plugin'
import type { NextFontManifest } from '../../plugins/next-font-manifest-plugin'

import type { ManifestRewriteRoute } from '../../..'
import { SERVER_RUNTIME } from '../../../../lib/constants'
import type { PAGE_TYPES } from '../../../../lib/page-types'
import {
  WebNextRequest,
  WebNextResponse,
} from '../../../../server/base-http/web'
import WebServer from '../../../../server/web-server'
import type { NextRequestHint } from '../../../../server/web/adapter'
import { normalizeAppPath } from '../../../../shared/lib/router/utils/app-paths'
import type { SizeLimit } from '../../../../types'

export function getRender({
  dev,
  page,
  appMod,
  pageMod,
  errorMod,
  error500Mod,
  pagesType,
  Document,
  buildManifest,
  reactLoadableManifest,
  dynamicCssManifest,
  interceptionRouteRewrites,
  renderToHTML,
  clientReferenceManifest,
  subresourceIntegrityManifest,
  serverActionsManifest,
  serverActions,
  config,
  buildId,
  nextFontManifest,
  incrementalCacheHandler,
}: {
  pagesType: PAGE_TYPES
  dev: boolean
  page: string
  appMod: any
  pageMod: any
  errorMod: any
  error500Mod: any
  renderToHTML?: any
  Document: DocumentType
  buildManifest: BuildManifest
  reactLoadableManifest: ReactLoadableManifest
  dynamicCssManifest?: DynamicCssManifest
  subresourceIntegrityManifest?: Record<string, string>
  interceptionRouteRewrites?: ManifestRewriteRoute[]
  clientReferenceManifest?: ClientReferenceManifest
  serverActionsManifest?: any
  serverActions?: {
    bodySizeLimit?: SizeLimit
    allowedOrigins?: string[]
  }
  config: NextConfigComplete
  buildId: string
  nextFontManifest: NextFontManifest
  incrementalCacheHandler?: any
}) {
  const isAppPath = pagesType === 'app'
  const baseLoadComponentResult = {
    dev,
    buildManifest,
    reactLoadableManifest,
    dynamicCssManifest,
    subresourceIntegrityManifest,
    Document,
    App: appMod?.default as AppType,
    clientReferenceManifest,
  }

  const server = new WebServer({
    dev,
    conf: config,
    minimalMode: true,
    webServerConfig: {
      page,
      pathname: isAppPath ? normalizeAppPath(page) : page,
      pagesType,
      interceptionRouteRewrites,
      extendRenderOpts: {
        buildId,
        runtime: SERVER_RUNTIME.experimentalEdge,
        supportsDynamicResponse: true,
        disableOptimizedLoading: true,
        serverActionsManifest,
        serverActions,
        nextFontManifest,
      },
      renderToHTML,
      incrementalCacheHandler,
      loadComponent: async (inputPage) => {
        if (inputPage === page) {
          return {
            ...baseLoadComponentResult,
            Component: pageMod.default,
            pageConfig: pageMod.config || {},
            getStaticProps: pageMod.getStaticProps,
            getServerSideProps: pageMod.getServerSideProps,
            getStaticPaths: pageMod.getStaticPaths,
            ComponentMod: pageMod,
            isAppPath: !!pageMod.__next_app__,
            page: inputPage,
            routeModule: pageMod.routeModule,
          }
        }

        // If there is a custom 500 page, we need to handle it separately.
        if (inputPage === '/500' && error500Mod) {
          return {
            ...baseLoadComponentResult,
            Component: error500Mod.default,
            pageConfig: error500Mod.config || {},
            getStaticProps: error500Mod.getStaticProps,
            getServerSideProps: error500Mod.getServerSideProps,
            getStaticPaths: error500Mod.getStaticPaths,
            ComponentMod: error500Mod,
            page: inputPage,
            routeModule: error500Mod.routeModule,
          }
        }

        if (inputPage === '/_error') {
          return {
            ...baseLoadComponentResult,
            Component: errorMod.default,
            pageConfig: errorMod.config || {},
            getStaticProps: errorMod.getStaticProps,
            getServerSideProps: errorMod.getServerSideProps,
            getStaticPaths: errorMod.getStaticPaths,
            ComponentMod: errorMod,
            page: inputPage,
            routeModule: errorMod.routeModule,
          }
        }

        return null
      },
    },
  })

  const handler = server.getRequestHandler()

  return function getBunRender(hint: NextRequestHint) {
    const extendedReq = new WebNextRequest(hint)
    const extendedRes = new WebNextResponse(undefined)
    const result = extendedRes.toResponse()

    const run = () => {
      handler(extendedReq, extendedRes)
    }

    return {
      run,
      result,
      extendedReq,
      extendedRes,
    }
  }
}
