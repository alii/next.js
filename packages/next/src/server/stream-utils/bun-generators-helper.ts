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

export function generatorToStream<T>(
  generator: AsyncStreamGenerator<T>
): ReadableStream<T> {
  return new ReadableStream({
    async start(controller) {
      for await (const chunk of generator) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })
}

async function* streamToGenerator<T>(
  stream: ReadableStream<T> | AsyncStreamGenerator<T>
): AsyncStreamGenerator<T> {
  if (stream instanceof ReadableStream) {
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        yield value
      }
    } finally {
      reader.releaseLock()
    }
  } else {
    yield* stream
  }
}

export async function* chainGenerators<T>(
  ...generators: AsyncStreamGenerator<T>[]
): AsyncStreamGenerator<T> {
  for (const generator of generators) {
    yield* generator
  }
}

export async function* flattenGenerators<T>(
  source: AsyncStreamGenerator<T>,
  generators: (
    | ((source: AsyncStreamGenerator<T>) => AsyncStreamGenerator<T>)
    | null
    | false
    | undefined
  )[]
): AsyncStreamGenerator<T> {
  let current = source
  for (const generator of generators) {
    if (generator) current = generator(current)
  }
  yield* current
}

/**
 * Creates a generator that inserts content into the HTML stream at the </head> tag.
 * This implementation exactly matches the behavior of the original transform stream:
 * - If already inserted, prepends any new insertion content before each chunk
 * - If not inserted, searches for </head> tag and inserts content there
 * - For PPR/partial renders, prepends content when tag isn't found
 * - Implements flush phase to ensure insertion happens if any bytes were processed
 */
async function* createHeadInsertion(
  getContent: () => Promise<string>,
  generator: AsyncStreamGenerator<Uint8Array>
): AsyncStreamGenerator<Uint8Array> {
  let inserted = false
  let hasBytes = false
  const closingHeadTag = encoder.encode('</head>')

  for await (const chunk of generator) {
    hasBytes = true
    const insertion = await getContent()

    if (inserted) {
      // If we've already inserted and have more content, prepend it
      if (insertion) {
        yield encoder.encode(insertion)
      }
      yield chunk
    } else {
      // Search for </head> in the chunk
      const index = indexOfUint8Array(chunk, closingHeadTag)
      if (index !== -1) {
        // Found the </head> tag - insert content exactly at this point
        if (insertion) {
          const encodedInsertion = encoder.encode(insertion)
          const newChunk = new Uint8Array(
            chunk.length + encodedInsertion.length
          )
          newChunk.set(chunk.subarray(0, index))
          newChunk.set(encodedInsertion, index)
          newChunk.set(chunk.subarray(index), index + encodedInsertion.length)
          yield newChunk
        } else {
          yield chunk
        }
        inserted = true
      } else {
        // No </head> tag found - this happens in PPR/partial renders
        if (insertion) {
          yield encoder.encode(insertion)
        }
        yield chunk
        inserted = true
      }
    }
  }

  // Flush phase: if any bytes were processed, get and yield any final insertion
  if (hasBytes) {
    const insertion = await getContent()
    if (insertion) {
      yield encoder.encode(insertion)
    }
  }
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

// Update the type to accept either a ReadableStream or AsyncStreamGenerator
export type BunFizzStreamOptions = {
  inlinedDataStream:
    | AsyncStreamGenerator<Uint8Array>
    | ReadableStream<Uint8Array>
    | undefined
  isStaticGeneration: boolean
  getServerInsertedHTML: () => Promise<string>
  getServerInsertedMetadata: () => Promise<string>
  validateRootLayout?: boolean
  suffix?: string | undefined
}

// Main stream processing function for Bun
export async function* continueFizzStream(
  renderStream: ReadableStream<Uint8Array>,
  {
    suffix,
    inlinedDataStream,
    isStaticGeneration,
    getServerInsertedHTML,
    getServerInsertedMetadata,
    validateRootLayout,
  }: {
    suffix?: string
    inlinedDataStream?:
      | AsyncStreamGenerator<Uint8Array>
      | ReadableStream<Uint8Array>
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

  yield* flattenGenerators(streamToGenerator(renderStream), [
    (g) => createHeadInsertion(getServerInsertedMetadata, g),

    suffixUnclosed != null &&
      suffixUnclosed.length > 0 &&
      ((g) => createDeferredSuffix(suffixUnclosed, g)),

    inlinedDataStream &&
      ((g) => chainGenerators(g, streamToGenerator(inlinedDataStream))),

    validateRootLayout && ((g) => createRootLayoutValidator(g)),

    (g) => createMoveSuffix(g),

    (g) => createHeadInsertion(getServerInsertedHTML, g),
  ])
}

// Update continueDynamicPrerender to handle streams directly
export async function* continueDynamicPrerender(
  prerenderStream: ReadableStream<Uint8Array>,
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
  generator = createHeadInsertion(getServerInsertedHTML, generator)
  generator = createHeadInsertion(getServerInsertedMetadata, generator)

  yield* generator
}

// Update continueStaticPrerender to handle streams directly
export async function* continueStaticPrerender(
  prerenderStream: ReadableStream<Uint8Array>,
  {
    inlinedDataStream,
    getServerInsertedHTML,
    getServerInsertedMetadata,
  }: {
    inlinedDataStream: AsyncStreamGenerator<Uint8Array>
    getServerInsertedHTML: () => Promise<string>
    getServerInsertedMetadata: () => Promise<string>
  }
): AsyncStreamGenerator<Uint8Array> {
  let generator = streamToGenerator(prerenderStream)

  generator = createBufferedGenerator(generator)
  generator = await createHeadInsertion(getServerInsertedHTML, generator)
  generator = await createHeadInsertion(getServerInsertedMetadata, generator)

  if (inlinedDataStream) {
    generator = chainGenerators(generator, inlinedDataStream)
  }

  generator = createMoveSuffix(generator)

  yield* generator
}

// Update continueDynamicHTMLResume to handle streams directly
export async function* continueDynamicHTMLResume(
  renderStream: ReadableStream<Uint8Array>,
  {
    inlinedDataStream,
    getServerInsertedHTML,
    getServerInsertedMetadata,
  }: {
    inlinedDataStream: AsyncStreamGenerator<Uint8Array>
    getServerInsertedHTML: () => Promise<string>
    getServerInsertedMetadata: () => Promise<string>
  }
): AsyncStreamGenerator<Uint8Array> {
  let generator = streamToGenerator(renderStream)

  generator = createBufferedGenerator(generator)
  generator = createHeadInsertion(getServerInsertedHTML, generator)
  generator = createHeadInsertion(getServerInsertedMetadata, generator)

  if (inlinedDataStream) {
    generator = chainGenerators(generator, inlinedDataStream)
  }

  generator = createMoveSuffix(generator)

  yield* generator
}

export async function* createDocumentClosingGenerator(): AsyncStreamGenerator<Uint8Array> {
  yield* stringToGenerator('</body></html>')
}
