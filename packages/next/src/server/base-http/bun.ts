import type { OutgoingHttpHeaders } from 'node:http'
import { DetachedPromise } from '../../lib/detached-promise'
import { NextRequest } from '../web/exports'
// import { CloseController } from '../web/web-on-close'
import { BaseNextRequest, BaseNextResponse, type FetchMetric } from './index'

export class BunNextRequest extends BaseNextRequest<ReadableStream<Uint8Array> | null> {
  private readonly request: Request

  public fetchMetrics: FetchMetric[] | undefined
  private readonly originalUrl: URL

  constructor(url: URL, request: Request) {
    super(request.method, url.pathname, request.body)
    this.originalUrl = url
    this.request = request
  }

  public get headers() {
    return Object.fromEntries([...this.request.headers.entries()])
  }

  public toNextRequest(): NextRequest {
    return new NextRequest(this.originalUrl, this.request)
  }
}

declare interface BunHeadersExtension extends Headers {
  toJSON(): OutgoingHttpHeaders
}

export class BunNextResponse extends BaseNextResponse {
  private headers = new Headers() as BunHeadersExtension

  // private readonly closeController = new CloseController()

  public statusCode: number | undefined
  public statusMessage: string | undefined

  public constructor() {
    super()
  }

  public setHeader(name: string, value: string | string[]): this {
    this.headers.delete(name)

    for (const val of Array.isArray(value) ? value : [value]) {
      this.headers.append(name, val)
    }

    return this
  }

  public removeHeader(name: string): this {
    this.headers.delete(name)
    return this
  }

  public getHeaderValues(name: string): string[] | undefined {
    // https://developer.mozilla.org/docs/Web/API/Headers/get#example
    return this.getHeader(name)
      ?.split(',')
      .map((v) => v.trimStart())
  }

  public getHeader(name: string): string | undefined {
    return this.headers.get(name) ?? undefined
  }

  public getHeaders(): OutgoingHttpHeaders {
    return this.headers.toJSON()
  }

  public hasHeader(name: string): boolean {
    return this.headers.has(name)
  }

  public appendHeader(name: string, value: string): this {
    this.headers.append(name, value)
    return this
  }

  private init: Response | string | ReadableStream | null = null

  public body(value: string): this {
    this.init = value
    return this
  }

  public resolveAsStreamOrTextOrResponse(
    value: ReadableStream | string | Response | null
  ) {
    this.init = value
    this.send()
  }

  public isStaticAsset = false

  private readonly sendPromise = new DetachedPromise<Response>()

  private _sent = false
  public send() {
    if (this.init instanceof Response) {
      this.sendPromise.resolve(this.init)
    } else {
      this.sendPromise.resolve(
        new Response(this.init, {
          headers: this.headers,
          status: this.statusCode,
          statusText: this.statusMessage,
        })
      )
    }

    // this.closeController.dispatchClose()

    this._sent = true
  }

  get sent() {
    return this._sent
  }

  public toResponse() {
    return this.sendPromise.promise
  }

  public onClose(/*callback: () => void*/) {
    throw new Error('Not implemented')
    // if (this.closeController.isClosed) {
    //   throw new Error(
    //     'Cannot call onClose on a BunNextResponse that is already closed'
    //   )
    // }

    // return this.closeController.onClose(callback)
  }
}
