import type { OutgoingHttpHeaders } from 'node:http'
import { DetachedPromise } from '../../lib/detached-promise'
import { NextRequest } from '../web/exports'
import { toNodeOutgoingHttpHeaders } from '../web/utils'
import { CloseController, trackBodyConsumed } from '../web/web-on-close'
import { BaseNextRequest, BaseNextResponse, type FetchMetric } from './index'

export class BunNextRequest extends BaseNextRequest<ReadableStream<Uint8Array> | null> {
  private readonly request: Request

  public fetchMetrics: FetchMetric[] | undefined

  public readonly actualUrl: URL

  constructor(url: URL, request: Request) {
    super(request.method, request.url, request.body)
    this.request = request
    this.url = url.pathname
    this.actualUrl = url
  }

  public get headers() {
    return Object.fromEntries([...this.request.headers.entries()])
  }

  public toNextRequest(): NextRequest {
    return new NextRequest(this.request)
  }
}

export class BunNextResponse extends BaseNextResponse<WritableStream> {
  private headers = new Headers()
  private textBody: string | undefined = undefined

  public override destination: WritableStream

  private readonly closeController = new CloseController()

  public statusCode: number | undefined
  public statusMessage: string | undefined

  private readonly transformStream: TransformStream

  public constructor() {
    const transformStream = new TransformStream()

    super(transformStream.writable)

    this.destination = transformStream.writable
    this.transformStream = transformStream
  }

  public get writable() {
    return this.transformStream.writable
  }

  public get readable() {
    return this.transformStream.readable
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
    return toNodeOutgoingHttpHeaders(this.headers)
  }

  public hasHeader(name: string): boolean {
    return this.headers.has(name)
  }

  public appendHeader(name: string, value: string): this {
    this.headers.append(name, value)
    return this
  }

  public body(value: string) {
    this.textBody = value
    return this
  }

  private readonly sendPromise = new DetachedPromise<Response | void>()

  private _sent = false
  public send() {
    this.sendPromise.resolve()
    this._sent = true
  }

  get sent() {
    return this._sent
  }

  /**
   * Resolve the internal send promise to be a response directly
   * @param response The response
   */
  public async resolveAsResponse(response: Response) {
    this.sendPromise.resolve(response)
    this._sent = true
  }

  public async toResponse() {
    const response = await this.sendPromise.promise

    if (response) {
      return response
    }

    const body = this.textBody ?? this.transformStream.readable

    let bodyInit: BodyInit = body

    // if the response is streaming, onClose() can still be called after this point.
    const canAddListenersLater = typeof bodyInit !== 'string'
    const shouldTrackBody =
      canAddListenersLater || this.closeController.listeners > 0

    if (shouldTrackBody) {
      bodyInit = trackBodyConsumed(body, () => {
        this.closeController.dispatchClose()
      })
    }

    return new Response(bodyInit, {
      headers: this.headers,
      status: this.statusCode,
      statusText: this.statusMessage,
    })
  }

  public onClose(callback: () => void) {
    if (this.closeController.isClosed) {
      throw new Error(
        'Cannot call onClose on a WebNextResponse that is already closed'
      )
    }

    return this.closeController.onClose(callback)
  }
}
