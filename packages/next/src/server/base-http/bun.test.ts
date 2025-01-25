import { BunNextResponse } from './bun'

describe('BunNextResponse onClose', () => {
  it('stream body', async () => {
    const cb = jest.fn()
    const ts = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk)
      },
    })

    const bunNextResponse = new BunNextResponse(ts)
    bunNextResponse.onClose(cb)
    bunNextResponse.send()
    expect(cb).toHaveBeenCalledTimes(0)
    const response = await bunNextResponse.toResponse()
    expect(cb).toHaveBeenCalledTimes(0)
    const t = response.text()

    const encoder = new TextEncoder()
    const writer = ts.writable.getWriter()
    await writer.write(encoder.encode('abc'))
    await writer.write(encoder.encode('def'))
    await writer.close()

    const text = await t
    expect(cb).toHaveBeenCalledTimes(1)
    expect(text).toBe('abcdef')
  })

  it('string body', async () => {
    const cb = jest.fn()
    const bunNextResponse = new BunNextResponse(undefined).body('abcdef')
    bunNextResponse.onClose(cb)
    bunNextResponse.send()
    expect(cb).toHaveBeenCalledTimes(0)
    const response = await bunNextResponse.toResponse()
    expect(cb).toHaveBeenCalledTimes(0)
    const text = await response.text()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(text).toBe('abcdef')
  })
})
