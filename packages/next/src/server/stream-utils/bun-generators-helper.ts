import { isBun } from '../base-http/helpers'
import { ENCODED_TAGS } from './encodedTags'
import {
  indexOfUint8Array,
  isEquivalentUint8Arrays,
  removeFromUint8Array,
} from './uint8array-helpers'

const encoder = new TextEncoder()

export type ReactReadableStream = ReadableStream<Uint8Array> & {
  allReady?: Promise<void> | undefined
}

// Core async generator type for transforming chunks
type AsyncStreamGenerator<T> = AsyncGenerator<T, void, unknown>

// Helper to convert an async generator to a ReadableStream
async function* chainGenerators<T>(
  generator1: AsyncStreamGenerator<T>,
  generator2: AsyncStreamGenerator<T>
): AsyncStreamGenerator<T> {
  for await (const chunk of generator1) {
    yield chunk
  }
  for await (const chunk of generator2) {
    yield chunk
  }
}

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

// Head insertion generator
async function* createHeadInsertion(
  insert: () => Promise<string>,
  generator: AsyncStreamGenerator<Uint8Array>
): AsyncStreamGenerator<Uint8Array> {
  let inserted = false
  let hasBytes = false

  for await (const chunk of generator) {
    hasBytes = true
    const insertion = await insert()

    if (inserted) {
      if (insertion) {
        yield encoder.encode(insertion)
      }
      yield chunk
    } else {
      const index = indexOfUint8Array(chunk, ENCODED_TAGS.CLOSED.HEAD)
      if (index !== -1) {
        if (insertion) {
          const encodedInsertion = encoder.encode(insertion)
          const insertedHeadContent = new Uint8Array(
            chunk.length + encodedInsertion.length
          )
          insertedHeadContent.set(chunk.slice(0, index))
          insertedHeadContent.set(encodedInsertion, index)
          insertedHeadContent.set(
            chunk.slice(index),
            index + encodedInsertion.length
          )
          yield insertedHeadContent
        } else {
          yield chunk
        }
        inserted = true
      } else {
        if (insertion) {
          yield encoder.encode(insertion)
        }
        yield chunk
        inserted = true
      }
    }
  }

  if (hasBytes) {
    const insertion = await insert()
    if (insertion) {
      yield encoder.encode(insertion)
    }
  }
}

// Deferred suffix generator
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

const CLOSE_TAG = '</body></html>'

// Move suffix generator
async function* createMoveSuffix(
  generator: AsyncStreamGenerator<Uint8Array>
): AsyncStreamGenerator<Uint8Array> {
  let foundSuffix = false

  for await (const chunk of generator) {
    if (foundSuffix) {
      yield chunk
      continue
    }

    const index = indexOfUint8Array(chunk, ENCODED_TAGS.CLOSED.BODY_AND_HTML)
    if (index > -1) {
      foundSuffix = true

      if (chunk.length === ENCODED_TAGS.CLOSED.BODY_AND_HTML.length) {
        continue
      }

      yield chunk.slice(0, index)

      if (chunk.length > ENCODED_TAGS.CLOSED.BODY_AND_HTML.length + index) {
        yield chunk.slice(index + ENCODED_TAGS.CLOSED.BODY_AND_HTML.length)
      }
    } else {
      yield chunk
    }
  }

  yield ENCODED_TAGS.CLOSED.BODY_AND_HTML
}

// Strip document closing tags generator
async function* createStripDocumentClosingTags(
  generator: AsyncStreamGenerator<Uint8Array>
): AsyncStreamGenerator<Uint8Array> {
  for await (const chunk of generator) {
    if (
      isEquivalentUint8Arrays(chunk, ENCODED_TAGS.CLOSED.BODY_AND_HTML) ||
      isEquivalentUint8Arrays(chunk, ENCODED_TAGS.CLOSED.BODY) ||
      isEquivalentUint8Arrays(chunk, ENCODED_TAGS.CLOSED.HTML)
    ) {
      continue
    }

    let modifiedChunk = removeFromUint8Array(chunk, ENCODED_TAGS.CLOSED.BODY)
    modifiedChunk = removeFromUint8Array(
      modifiedChunk,
      ENCODED_TAGS.CLOSED.HTML
    )

    yield modifiedChunk
  }
}

// Root layout validator generator
async function* createRootLayoutValidator(
  generator: AsyncStreamGenerator<Uint8Array>
): AsyncStreamGenerator<Uint8Array> {
  let foundHtml = false
  let foundBody = false

  for await (const chunk of generator) {
    if (
      !foundHtml &&
      indexOfUint8Array(chunk, ENCODED_TAGS.OPENING.HTML) > -1
    ) {
      foundHtml = true
    }

    if (
      !foundBody &&
      indexOfUint8Array(chunk, ENCODED_TAGS.OPENING.BODY) > -1
    ) {
      foundBody = true
    }

    yield chunk
  }

  const missingTags: string[] = []
  if (!foundHtml) missingTags.push('html')
  if (!foundBody) missingTags.push('body')

  if (missingTags.length) {
    yield encoder.encode(
      `<script>self.__next_root_layout_missing_tags=${JSON.stringify(missingTags)}</script>`
    )
  }
}

// Helper to convert stream to generator
async function* streamToGenerator<T>(
  stream: ReadableStream<T>
): AsyncStreamGenerator<T> {
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
}

// Helper to convert generator to stream
function generatorToStream<T>(
  generator: AsyncStreamGenerator<T>
): ReadableStream<T> {
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of generator) {
          controller.enqueue(chunk)
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

export type ContinueStreamOptions = {
  inlinedDataStream: ReadableStream<Uint8Array> | undefined
  isStaticGeneration: boolean
  getServerInsertedHTML: () => Promise<string>
  getServerInsertedMetadata: () => Promise<string>
  validateRootLayout?: boolean
  suffix?: string | undefined
}

export type ContinueDynamicPrerenderOptions = {
  getServerInsertedHTML: () => Promise<string>
  getServerInsertedMetadata: () => Promise<string>
}

export type ContinueStaticPrerenderOptions = {
  inlinedDataStream: ReadableStream<Uint8Array>
  getServerInsertedHTML: () => Promise<string>
  getServerInsertedMetadata: () => Promise<string>
}

export type ContinueResumeOptions = {
  inlinedDataStream: ReadableStream<Uint8Array>
  getServerInsertedHTML: () => Promise<string>
  getServerInsertedMetadata: () => Promise<string>
}

// Main stream processing functions
export async function continueFizzStream(
  renderStream: ReactReadableStream,
  {
    suffix,
    inlinedDataStream,
    isStaticGeneration,
    getServerInsertedHTML,
    getServerInsertedMetadata,
    validateRootLayout,
  }: ContinueStreamOptions
): Promise<ReadableStream<Uint8Array>> {
  const suffixUnclosed = suffix ? suffix.split(CLOSE_TAG, 1)[0] : null

  if (isStaticGeneration && 'allReady' in renderStream) {
    await renderStream.allReady
  }

  let generator = streamToGenerator(renderStream)

  // Apply transformations in sequence
  if (!isBun) {
    generator = createBufferedGenerator(generator)
  }

  generator = createHeadInsertion(getServerInsertedMetadata, generator)

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
  generator = createHeadInsertion(getServerInsertedHTML, generator)

  return generatorToStream(generator)
}

export async function continueDynamicPrerender(
  prerenderStream: ReadableStream<Uint8Array>,
  {
    getServerInsertedHTML,
    getServerInsertedMetadata,
  }: ContinueDynamicPrerenderOptions
) {
  let generator = streamToGenerator(prerenderStream)

  generator = createBufferedGenerator(generator)
  generator = createStripDocumentClosingTags(generator)
  generator = createHeadInsertion(getServerInsertedHTML, generator)
  generator = createHeadInsertion(getServerInsertedMetadata, generator)

  return generatorToStream(generator)
}

export async function continueStaticPrerender(
  prerenderStream: ReadableStream<Uint8Array>,
  {
    inlinedDataStream,
    getServerInsertedHTML,
    getServerInsertedMetadata,
  }: ContinueStaticPrerenderOptions
) {
  let generator = streamToGenerator(prerenderStream)

  generator = createBufferedGenerator(generator)
  generator = createHeadInsertion(getServerInsertedHTML, generator)
  generator = createHeadInsertion(getServerInsertedMetadata, generator)

  if (inlinedDataStream) {
    generator = chainGenerators(generator, streamToGenerator(inlinedDataStream))
  }

  generator = createMoveSuffix(generator)

  return generatorToStream(generator)
}

export async function continueDynamicHTMLResume(
  renderStream: ReadableStream<Uint8Array>,
  {
    inlinedDataStream,
    getServerInsertedHTML,
    getServerInsertedMetadata,
  }: ContinueResumeOptions
) {
  let generator = streamToGenerator(renderStream)

  generator = createBufferedGenerator(generator)
  generator = createHeadInsertion(getServerInsertedHTML, generator)
  generator = createHeadInsertion(getServerInsertedMetadata, generator)

  if (inlinedDataStream) {
    generator = chainGenerators(generator, streamToGenerator(inlinedDataStream))
  }

  generator = createMoveSuffix(generator)

  return generatorToStream(generator)
}

export function createDocumentClosingStream(): ReadableStream<Uint8Array> {
  return generatorToStream(stringToGenerator(CLOSE_TAG))
}
