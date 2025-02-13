import type { BaseNextRequest, BaseNextResponse } from './'

import { BunNextRequest, BunNextResponse } from './bun'
import { NodeNextRequest, NodeNextResponse } from './node'
import type { WebNextRequest, WebNextResponse } from './web'

/**
 * This file provides some helpers that should be used in conjunction with
 * explicit environment checks. When combined with the environment checks, it
 * will ensure that the correct typings are used as well as enable code
 * elimination.
 */

/**
 * Type guard to determine if a request is a WebNextRequest. This does not
 * actually check the type of the request, but rather the runtime environment.
 * It's expected that when the runtime environment is the edge runtime, that any
 * base request is a WebNextRequest.
 */
export const isWebNextRequest = (req: BaseNextRequest): req is WebNextRequest =>
  process.env.NEXT_RUNTIME === 'edge'

/**
 * Type guard to determine if a response is a WebNextResponse. This does not
 * actually check the type of the response, but rather the runtime environment.
 * It's expected that when the runtime environment is the edge runtime, that any
 * base response is a WebNextResponse.
 */
export const isWebNextResponse = (
  res: BaseNextResponse
): res is WebNextResponse => process.env.NEXT_RUNTIME === 'edge'

/**
 * Type guard to determine if a request is a NodeNextRequest. This does not
 * actually check the type of the request, but rather the runtime environment.
 * It's expected that when the runtime environment is the node runtime, that any
 * base request is a NodeNextRequest.
 */
export const isNodeNextRequest = (
  req: BaseNextRequest
): req is NodeNextRequest => req instanceof NodeNextRequest

/**
 * Type guard to determine if a response is a NodeNextResponse. This does not
 * actually check the type of the response, but rather the runtime environment.
 * It's expected that when the runtime environment is the node runtime, that any
 * base response is a NodeNextResponse.
 */
export const isNodeNextResponse = (
  res: BaseNextResponse
): res is NodeNextResponse => res instanceof NodeNextResponse

export const isBun = typeof process.versions.bun === 'string'

export const isBunNextRequest = (req: BaseNextRequest): req is BunNextRequest =>
  req instanceof BunNextRequest

export const isBunNextResponse = (
  res: BaseNextResponse
): res is BunNextResponse => res instanceof BunNextResponse

export type ReqResOnRuntimes = {
  node: { req: NodeNextRequest; res: NodeNextResponse }
  bun: { req: BunNextRequest; res: BunNextResponse }
  web: { req: WebNextRequest; res: WebNextResponse }
}

export function matchOnReqRes<T>(
  reqRes:
    | ReqResOnRuntimes[keyof ReqResOnRuntimes]
    | { req: BaseNextRequest; res: BaseNextResponse },
  map: Partial<{
    [Key in keyof ReqResOnRuntimes]: (reqRes: ReqResOnRuntimes[Key]) => T
  }>
) {
  switch (true) {
    case isNodeNextRequest(reqRes.req) && map.node !== undefined:
      return map.node(reqRes as never)
    case isBunNextRequest(reqRes.req) && map.bun !== undefined:
      return map.bun(reqRes as never)
    case isWebNextRequest(reqRes.req) && map.web !== undefined:
      return map.web(reqRes as never)
    default:
      throw new Error('matchOnReqRes() received an invalid request or response')
  }
}

export function matchOnReq<T>(
  req: BaseNextRequest,
  map: Partial<{
    [Key in keyof ReqResOnRuntimes]: (req: ReqResOnRuntimes[Key]['req']) => T
  }>
) {
  switch (true) {
    case isNodeNextRequest(req) && map.node !== undefined:
      return map.node(req as never)
    case isBunNextRequest(req) && map.bun !== undefined:
      return map.bun(req as never)
    case isWebNextRequest(req) && map.web !== undefined:
      return map.web(req as never)
    default:
      throw new Error('matchOnReq() received an invalid request')
  }
}

export function matchOnRes<T>(
  res: BaseNextResponse,
  map: Partial<{
    [Key in keyof ReqResOnRuntimes]: (res: ReqResOnRuntimes[Key]['res']) => T
  }>
) {
  switch (true) {
    case isNodeNextResponse(res) && map.node !== undefined:
      return map.node(res as never)
    case isBunNextResponse(res) && map.bun !== undefined:
      return map.bun(res as never)
    case isWebNextResponse(res) && map.web !== undefined:
      return map.web(res as never)
    default:
      throw new Error('matchOnRes() received an invalid request or response')
  }
}
