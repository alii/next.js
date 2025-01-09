// eslint-disable-next-line import/no-extraneous-dependencies
export {
  createTemporaryReferenceSet,
  decodeAction,
  decodeFormState,
  decodeReply,
  renderToReadableStream,
} from 'react-server-dom-webpack/server.edge'

// eslint-disable-next-line import/no-extraneous-dependencies
export { prerender } from 'react-server-dom-webpack/static.edge'
export { collectSegmentData } from './collect-segment-data'

import { ClientPageRoot } from '../../client/components/client-page'
import { ClientSegmentRoot } from '../../client/components/client-segment'
import * as serverHooks from '../../client/components/hooks-server-context'
import { HTTPAccessFallbackBoundary } from '../../client/components/http-access-fallback/error-boundary'
import LayoutRouter from '../../client/components/layout-router'
import RenderFromTemplateContext from '../../client/components/render-from-template-context'
import { createMetadataComponents } from '../../lib/metadata/metadata'
import { actionAsyncStorage } from '../app-render/action-async-storage.external'
import { workAsyncStorage } from '../app-render/work-async-storage.external'
import { patchFetch as _patchFetch } from '../lib/patch-fetch'
import {
  createPrerenderParamsForClientSegment,
  createServerParamsForMetadata,
  createServerParamsForServerSegment,
} from '../request/params'
import {
  createPrerenderSearchParamsForClientPage,
  createServerSearchParamsForMetadata,
  createServerSearchParamsForServerPage,
} from '../request/search-params'
import { workUnitAsyncStorage } from './work-unit-async-storage.external'
// not being used but needs to be included in the client manifest for /_not-found
import '../../client/components/error-boundary'
import {
  MetadataBoundary,
  OutletBoundary,
  ViewportBoundary,
} from '../../lib/metadata/metadata-boundary'

import { Postpone } from './rsc/postpone'
import { preconnect, preloadFont, preloadStyle } from './rsc/preloads'
import { taintObjectReference } from './rsc/taint'

// patchFetch makes use of APIs such as `React.unstable_postpone` which are only available
// in the experimental channel of React, so export it from here so that it comes from the bundled runtime
function patchFetch() {
  return _patchFetch({
    workAsyncStorage,
    workUnitAsyncStorage,
  })
}

export {
  actionAsyncStorage,
  ClientPageRoot,
  ClientSegmentRoot,
  createMetadataComponents,
  createPrerenderParamsForClientSegment,
  createPrerenderSearchParamsForClientPage,
  createServerParamsForMetadata,
  createServerParamsForServerSegment,
  createServerSearchParamsForMetadata,
  createServerSearchParamsForServerPage,
  HTTPAccessFallbackBoundary,
  LayoutRouter,
  MetadataBoundary,
  OutletBoundary,
  patchFetch,
  Postpone,
  preconnect,
  preloadFont,
  preloadStyle,
  RenderFromTemplateContext,
  serverHooks,
  taintObjectReference,
  ViewportBoundary,
  workAsyncStorage,
  workUnitAsyncStorage,
}
