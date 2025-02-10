declare global {
  interface BunDirectReadableStreamController<T>
    extends ReadableStreamDefaultController<T> {
    write: (chunk: T) => void
  }

  interface BunUnderlyingDirectSource<T> {
    type: 'direct'

    cancel?: UnderlyingSourceCancelCallback

    pull?: (
      controller: BunDirectReadableStreamController<T>
    ) => void | PromiseLike<void>

    start?: (controller: BunDirectReadableStreamController<T>) => void
  }

  interface BunDirectTransformController<U> {
    enqueue: (chunk: U) => void
  }

  interface BunDirectTransformer<T, U> {
    transform?: (
      chunk: T,
      controller: BunDirectTransformController<U>
    ) => void | Promise<void>

    flush?: (
      controller: BunDirectTransformController<U>
    ) => void | Promise<void>

    cancel?: (reason: any) => void | Promise<void>
  }
}

declare var ReadableStream: {
  new <R = any>(
    underlyingSource: BunUnderlyingDirectSource<R>
  ): ReadableStream<R>
  new (
    underlyingSource: UnderlyingByteSource,
    strategy?: { highWaterMark?: number }
  ): ReadableStream<Uint8Array>
  new <R = any>(
    underlyingSource: UnderlyingDefaultSource<R>,
    strategy?: QueuingStrategy<R>
  ): ReadableStream<R>
  new <R = any>(
    underlyingSource?: UnderlyingSource<R>,
    strategy?: QueuingStrategy<R>
  ): ReadableStream<R>
}

export class BunDirectReadableStream<T> extends ReadableStream<T> {
  public constructor(
    underlyingSource: Omit<BunUnderlyingDirectSource<T>, 'type'>
  ) {
    super({ type: 'direct', ...underlyingSource })
  }
}

/**
 * This is a helper class that is similar to a TransformStream, but
 * uses an optimised type: 'direct' ReadableStream underlying source.
 */
export class BunReadableWritablePair<T, U>
  implements ReadableWritablePair<U, T>
{
  public readonly readable: ReadableStream<U>
  public readonly writable: WritableStream<T>

  private readonly transformer: BunDirectTransformer<T, U>

  private readableController: BunDirectReadableStreamController<U> | undefined =
    undefined

  public constructor(transformer: BunDirectTransformer<T, U>) {
    this.transformer = transformer

    this.readable = new BunDirectReadableStream<U>({
      start: () => {
        //
      },
      pull: async (controller) => {
        this.readableController = controller
      },
      cancel: (reason) => {
        return this.transformer.cancel?.(reason)
      },
    })

    this.writable = new WritableStream<T>({
      start: (controller) => {
        controller.signal.addEventListener('abort', () => {
          this.transformer.cancel?.(controller.signal.reason)
        })
      },
      write: async (chunk) => {
        if (!this.readableController) {
          throw new Error(
            'Readable controller not initialized (writable.write() callback)'
          )
        }

        if (this.transformer.transform) {
          await this.transformer.transform(chunk, {
            enqueue: (c) => {
              if (!this.readableController) {
                throw new Error(
                  'Readable controller not initialized (transform.enqueue() callback)'
                )
              }

              this.readableController.write(c)
            },
          })
        } else {
          this.readableController.enqueue(chunk as never)
        }
      },
      close: () => {
        if (!this.readableController) {
          throw new Error(
            'Readable controller not initialized (writable.close() callback)'
          )
        }

        this.readableController.close()
      },
      abort: (reason) => {
        if (!this.readableController) {
          throw new Error(
            'Readable controller not initialized (writable.abort() callback)'
          )
        }

        this.readableController.error(reason)
      },
    })
  }
}
