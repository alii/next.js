import type { ServerConsumerManifest } from 'react-server-dom-webpack/client.edge'
import type { ClientReferenceManifest } from '../../../build/webpack/plugins/flight-manifest-plugin'
import type { DeepReadonly } from '../../../shared/lib/deep-readonly'
import { htmlEscapeJsonString } from '../../htmlescape'
import type { AsyncStreamGenerator } from '../../stream-utils/bun-generators-helper'
import type { BinaryStreamOf } from '../../utils'

const isEdgeRuntime = process.env.NEXT_RUNTIME === 'edge'

const INLINE_FLIGHT_PAYLOAD_BOOTSTRAP = 0
const INLINE_FLIGHT_PAYLOAD_DATA = 1
const INLINE_FLIGHT_PAYLOAD_FORM_STATE = 2
const INLINE_FLIGHT_PAYLOAD_BINARY = 3

const flightResponses = new WeakMap<BinaryStreamOf<any>, Promise<any>>()
const encoder = new TextEncoder()

/**
 * Render Flight stream.
 * This is only used for renderToHTML, the Flight response does not need additional wrappers.
 */
export function useFlightStream<T>(
  flightStream: BinaryStreamOf<T>,
  clientReferenceManifest: DeepReadonly<ClientReferenceManifest>,
  nonce?: string
): Promise<T> {
  const response = flightResponses.get(flightStream)

  if (response) {
    return response
  }

  // react-server-dom-webpack/client.edge must not be hoisted for require cache clearing to work correctly
  let createFromReadableStream: (
    stream: ReadableStream<Uint8Array>,
    options: {
      serverConsumerManifest: ServerConsumerManifest
      nonce?: string
    }
  ) => Promise<T>
  // @TODO: investigate why the aliasing for turbopack doesn't pick this up, requiring this runtime check
  if (process.env.TURBOPACK) {
    createFromReadableStream =
      // eslint-disable-next-line import/no-extraneous-dependencies
      require('react-server-dom-turbopack/client.edge').createFromReadableStream
  } else {
    createFromReadableStream =
      // eslint-disable-next-line import/no-extraneous-dependencies
      require('react-server-dom-webpack/client.edge').createFromReadableStream
  }

  const newResponse = createFromReadableStream(flightStream, {
    serverConsumerManifest: {
      moduleLoading: clientReferenceManifest.moduleLoading,
      moduleMap: isEdgeRuntime
        ? clientReferenceManifest.edgeSSRModuleMapping
        : clientReferenceManifest.ssrModuleMapping,
      serverModuleMap: null,
    } as ServerConsumerManifest,
    nonce,
  })

  flightResponses.set(flightStream, newResponse)

  return newResponse
}

/**
 * Creates an async generator that yields inline script tag chunks for writing hydration
 * data to the client outside the React render itself.
 */
export async function* createInlinedDataGenerator(
  flightStream: AsyncStreamGenerator<Uint8Array> | ReadableStream<Uint8Array>,
  nonce: string | undefined,
  formState: unknown | null
): AsyncStreamGenerator<Uint8Array> {
  const startScriptTag = nonce
    ? `<script nonce=${JSON.stringify(nonce)}>`
    : '<script>'

  const decoder = new TextDecoder('utf-8', { fatal: true })

  // Write initial instructions
  if (formState != null) {
    yield encoder.encode(
      `${startScriptTag}(self.__next_f=self.__next_f||[]).push(${htmlEscapeJsonString(
        JSON.stringify([INLINE_FLIGHT_PAYLOAD_BOOTSTRAP])
      )});self.__next_f.push(${htmlEscapeJsonString(
        JSON.stringify([INLINE_FLIGHT_PAYLOAD_FORM_STATE, formState])
      )})</script>`
    )
  } else {
    yield encoder.encode(
      `${startScriptTag}(self.__next_f=self.__next_f||[]).push(${htmlEscapeJsonString(
        JSON.stringify([INLINE_FLIGHT_PAYLOAD_BOOTSTRAP])
      )})</script>`
    )
  }

  // Process flight data
  for await (const value of flightStream) {
    try {
      const decodedString = decoder.decode(value, { stream: true })
      yield* writeFlightDataInstruction(startScriptTag, decodedString)
    } catch {
      // The chunk cannot be decoded as valid UTF-8 string.
      yield* writeFlightDataInstruction(startScriptTag, value)
    }
  }

  // Final decode
  try {
    decoder.decode()
  } catch {
    // Ignore any decoding errors at the end
  }
}

async function* writeFlightDataInstruction(
  scriptStart: string,
  chunk: string | Uint8Array
): AsyncStreamGenerator<Uint8Array> {
  let htmlInlinedData: string

  if (typeof chunk === 'string') {
    htmlInlinedData = htmlEscapeJsonString(
      JSON.stringify([INLINE_FLIGHT_PAYLOAD_DATA, chunk])
    )
  } else {
    // The chunk cannot be embedded as a UTF-8 string in the script tag.
    // Instead let's inline it in base64.
    const base64 = btoa(String.fromCodePoint(...chunk))
    htmlInlinedData = htmlEscapeJsonString(
      JSON.stringify([INLINE_FLIGHT_PAYLOAD_BINARY, base64])
    )
  }

  yield encoder.encode(
    `${scriptStart}self.__next_f.push(${htmlInlinedData})</script>`
  )
}
