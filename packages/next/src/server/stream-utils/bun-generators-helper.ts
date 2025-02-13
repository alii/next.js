import type { ReactReadableStream } from './node-web-streams-helper'
import { indexOfUint8Array } from './uint8array-helpers'

const encoder = new TextEncoder()

export type AsyncStreamGenerator<T> = AsyncGenerator<T, void, unknown>

// Convert string to async generator
async function* stringToGenerator(
  str: string
): AsyncStreamGenerator<Uint8Array> {
  yield encoder.encode(str)
}

// Buffered generator that combines chunks
async function* createBufferedGenerator(
  generator: AsyncStreamGenerator<Uint8Array>
): AsyncStreamGenerator<Uint8Array> {
  let bufferedChunks: Array<Uint8Array> = []
  let bufferByteLength = 0

  for await (const chunk of generator) {
    bufferedChunks.push(chunk)
    bufferByteLength += chunk.byteLength

    const combinedChunk = new Uint8Array(bufferByteLength)
    let copiedBytes = 0

    for (const bufferedChunk of bufferedChunks) {
      combinedChunk.set(bufferedChunk, copiedBytes)
      copiedBytes += bufferedChunk.byteLength
    }

    bufferedChunks = []
    bufferByteLength = 0

    yield combinedChunk
  }
}

// Helper to convert stream to generator
async function* streamToGenerator<T>(
  stream: AsyncStreamGenerator<T> | ReactReadableStream
): AsyncStreamGenerator<T> {
  if (Symbol.asyncIterator in stream) {
    yield* stream as AsyncStreamGenerator<T>
    return
  }

  const reader = (stream as ReactReadableStream).getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

// Chain multiple generators together
async function* chainGenerators<T>(
  ...generators: AsyncStreamGenerator<T>[]
): AsyncStreamGenerator<T> {
  for (const generator of generators) {
    yield* generator
  }
}

// Create a generator that inserts head content
async function* createHeadInsertion(
  getContent: () => Promise<string>,
  generator: AsyncStreamGenerator<Uint8Array>
): AsyncStreamGenerator<Uint8Array> {
  const content = await getContent()
  if (content) {
    yield encoder.encode(content)
  }
  yield* generator
}

// Create a generator that validates root layout
async function* createRootLayoutValidator(
  generator: AsyncStreamGenerator<Uint8Array>
): AsyncStreamGenerator<Uint8Array> {
  let hasHtml = false
  let hasBody = false

  for await (const chunk of generator) {
    const str = new TextDecoder().decode(chunk)
    if (!hasHtml && str.includes('<html')) {
      hasHtml = true
    }
    if (!hasBody && str.includes('<body')) {
      hasBody = true
    }
    yield chunk
  }

  if (!hasHtml || !hasBody) {
    throw new Error(
      `Missing required elements: ${
        !hasHtml ? '<html>' : ''
      }${!hasBody ? '<body>' : ''}`
    )
  }
}

// Create a generator that moves suffix content to the end
async function* createMoveSuffix(
  generator: AsyncStreamGenerator<Uint8Array>
): AsyncStreamGenerator<Uint8Array> {
  let suffixChunks: Uint8Array[] = []
  let inSuffix = false

  for await (const chunk of generator) {
    if (inSuffix) {
      suffixChunks.push(chunk)
      continue
    }

    const suffixStart = indexOfUint8Array(
      chunk,
      encoder.encode('</body></html>')
    )
    if (suffixStart !== -1) {
      inSuffix = true
      const beforeSuffix = chunk.subarray(0, suffixStart)
      if (beforeSuffix.length > 0) {
        yield beforeSuffix
      }
      suffixChunks.push(chunk.subarray(suffixStart))
    } else {
      yield chunk
    }
  }

  // Yield all suffix chunks at the end
  for (const chunk of suffixChunks) {
    yield chunk
  }
}

// Create a generator that defers suffix content
async function* createDeferredSuffix(
  suffix: string,
  generator: AsyncStreamGenerator<Uint8Array>
): AsyncStreamGenerator<Uint8Array> {
  let flushed = false

  for await (const chunk of generator) {
    yield chunk

    if (!flushed) {
      flushed = true
      yield encoder.encode(suffix)
    }
  }

  if (!flushed) {
    yield encoder.encode(suffix)
  }
}

// Main stream processing function for Bun
export async function* continueFizzStream(
  renderStream: ReactReadableStream,
  {
    suffix,
    inlinedDataStream,
    isStaticGeneration,
    getServerInsertedHTML,
    getServerInsertedMetadata,
    validateRootLayout,
  }: {
    suffix?: string
    inlinedDataStream?: AsyncStreamGenerator<Uint8Array> | ReactReadableStream
    isStaticGeneration: boolean
    getServerInsertedHTML: () => Promise<string>
    getServerInsertedMetadata: () => Promise<string>
    validateRootLayout?: boolean
  }
): AsyncStreamGenerator<Uint8Array> {
  const suffixUnclosed = suffix ? suffix.split('</body></html>', 1)[0] : null

  if (isStaticGeneration && 'allReady' in renderStream) {
    await renderStream.allReady
  }

  let generator = streamToGenerator(renderStream)

  // Apply transformations in sequence
  generator = await createHeadInsertion(getServerInsertedMetadata, generator)

  if (suffixUnclosed != null && suffixUnclosed.length > 0) {
    generator = createDeferredSuffix(suffixUnclosed, generator)
  }

  if (inlinedDataStream) {
    generator = chainGenerators(generator, streamToGenerator(inlinedDataStream))
  }

  if (validateRootLayout) {
    generator = createRootLayoutValidator(generator)
  }

  generator = createMoveSuffix(generator)
  generator = await createHeadInsertion(getServerInsertedHTML, generator)

  yield* generator
}

export async function* continueDynamicPrerender(
  prerenderStream: AsyncStreamGenerator<Uint8Array> | ReactReadableStream,
  {
    getServerInsertedHTML,
    getServerInsertedMetadata,
  }: {
    getServerInsertedHTML: () => Promise<string>
    getServerInsertedMetadata: () => Promise<string>
  }
): AsyncStreamGenerator<Uint8Array> {
  let generator = streamToGenerator(prerenderStream)

  generator = createBufferedGenerator(generator)
  generator = await createHeadInsertion(getServerInsertedHTML, generator)
  generator = await createHeadInsertion(getServerInsertedMetadata, generator)

  yield* generator
}

export async function* continueStaticPrerender(
  prerenderStream: AsyncStreamGenerator<Uint8Array> | ReactReadableStream,
  {
    inlinedDataStream,
    getServerInsertedHTML,
    getServerInsertedMetadata,
  }: {
    inlinedDataStream: AsyncStreamGenerator<Uint8Array> | ReactReadableStream
    getServerInsertedHTML: () => Promise<string>
    getServerInsertedMetadata: () => Promise<string>
  }
): AsyncStreamGenerator<Uint8Array> {
  let generator = streamToGenerator(prerenderStream)

  generator = createBufferedGenerator(generator)
  generator = await createHeadInsertion(getServerInsertedHTML, generator)
  generator = await createHeadInsertion(getServerInsertedMetadata, generator)

  if (inlinedDataStream) {
    generator = chainGenerators(generator, streamToGenerator(inlinedDataStream))
  }

  generator = createMoveSuffix(generator)

  yield* generator
}

export async function* continueDynamicHTMLResume(
  renderStream: AsyncStreamGenerator<Uint8Array> | ReactReadableStream,
  {
    inlinedDataStream,
    getServerInsertedHTML,
    getServerInsertedMetadata,
  }: {
    inlinedDataStream: AsyncStreamGenerator<Uint8Array> | ReactReadableStream
    getServerInsertedHTML: () => Promise<string>
    getServerInsertedMetadata: () => Promise<string>
  }
): AsyncStreamGenerator<Uint8Array> {
  let generator = streamToGenerator(renderStream)

  generator = createBufferedGenerator(generator)
  generator = await createHeadInsertion(getServerInsertedHTML, generator)
  generator = await createHeadInsertion(getServerInsertedMetadata, generator)

  if (inlinedDataStream) {
    generator = chainGenerators(generator, streamToGenerator(inlinedDataStream))
  }

  generator = createMoveSuffix(generator)

  yield* generator
}

export async function* createDocumentClosingGenerator(): AsyncStreamGenerator<Uint8Array> {
  yield* stringToGenerator('</body></html>')
}
