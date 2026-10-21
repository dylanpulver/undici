'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { setImmediate } = require('node:timers/promises')
const { test } = require('node:test')

const { fetch, Request } = require('../..')
const { closeServerAsPromise } = require('../utils/node-http')

/**
 * @param {string} url
 * @param {AbortSignal} signal
 * @param {'constructor' | 'clone' | 'mixed'} operation
 */
function createRequest (url, signal, operation) {
  let request = new Request(url, { signal })

  for (let i = 0; i < 3; i++) {
    request = operation === 'constructor' || (operation === 'mixed' && i % 2 === 0)
      ? new Request(request)
      : request.clone()
  }

  return request
}

async function collectGarbage () {
  for (let i = 0; i < 5; i++) {
    await setImmediate()
    global.gc()
  }
}

test('request copies can replace or clear their source signal', () => {
  const source = new AbortController()
  const replacement = new AbortController()
  const request = new Request('http://localhost', { signal: source.signal })
  const inherited = new Request(request, { signal: undefined })
  const cleared = new Request(request, { signal: null })
  const replaced = new Request(request, { signal: replacement.signal })
  const sourceReason = new Error('cancel source')

  source.abort(sourceReason)

  assert.strictEqual(inherited.signal.reason, sourceReason)
  assert.strictEqual(cleared.signal.aborted, false)
  assert.strictEqual(replaced.signal.aborted, false)

  const replacementReason = new Error('cancel replacement')
  replacement.abort(replacementReason)

  assert.strictEqual(replaced.signal.reason, replacementReason)
  assert.strictEqual(cleared.signal.aborted, false)
})

test('request copies abort before later handlers on their source signal', () => {
  const controller = new AbortController()
  const request = new Request('http://localhost', { signal: controller.signal })
  const copy = new Request(request)
  let observed

  request.signal.addEventListener('abort', () => {
    observed = copy.signal.aborted
  }, { once: true })

  controller.abort()

  assert.strictEqual(observed, true)
})

test('request signals follow their source after garbage collection', {
  skip: typeof global.gc !== 'function'
}, async (t) => {
  for (const operation of ['constructor', 'clone', 'mixed']) {
    await t.test(operation, async () => {
      const controller = new AbortController()
      const { signal } = createRequest('http://localhost', controller.signal, operation)

      await collectGarbage()

      const reason = new Error('cancel request')
      controller.abort(reason)

      assert.strictEqual(signal.aborted, true)
      assert.strictEqual(signal.reason, reason)
    })
  }
})

test('request copies follow composite signals after garbage collection', {
  skip: typeof global.gc !== 'function'
}, async (t) => {
  for (const collectSourceAncestors of [false, true]) {
    await t.test(`collect source ancestors: ${collectSourceAncestors}`, async () => {
      const controller = new AbortController()
      let request

      if (collectSourceAncestors) {
        const source = AbortSignal.any([AbortSignal.any([controller.signal])])
        await collectGarbage()
        request = new Request('http://localhost', { signal: source })
      } else {
        request = new Request('http://localhost', { signal: AbortSignal.any([controller.signal]) })
      }

      await collectGarbage()

      const copy = new Request(request)
      const clone = request.clone()
      const reason = new Error('cancel composite request')
      controller.abort(reason)

      for (const { signal } of [request, copy, clone]) {
        assert.strictEqual(signal.aborted, true)
        assert.strictEqual(signal.reason, reason)
      }
    })
  }
})

test('fetch rejects when its upload stream aborts', async (t) => {
  const server = createServer(() => {})
  t.after(() => {
    server.closeAllConnections()
    return closeServerAsPromise(server)()
  })
  await once(server.listen(0), 'listening')

  const body = new ReadableStream({
    start (controller) {
      controller.error(new DOMException('upload failed', 'AbortError'))
    }
  })

  await assert.rejects(fetch(`http://localhost:${server.address().port}`, {
    method: 'POST',
    duplex: 'half',
    body
  }), { name: 'AbortError' })
})

test('fetch follows copied request signals after garbage collection', {
  skip: typeof global.gc !== 'function',
  timeout: 30000
}, async (t) => {
  for (const operation of ['constructor', 'clone', 'mixed']) {
    for (const phase of ['headers', 'body']) {
      await t.test(`${operation}: ${phase}`, async (t) => {
        const server = createServer((request, response) => {
          if (phase === 'body') response.write('chunk')
        })
        t.after(() => {
          server.closeAllConnections()
          return closeServerAsPromise(server)()
        })
        await once(server.listen(0), 'listening')

        const controller = new AbortController()
        const url = `http://localhost:${server.address().port}`
        const received = once(server, 'request')
        const response = fetch(createRequest(url, controller.signal, operation))
        let pending

        if (phase === 'body') {
          const reader = (await response).body.getReader()
          await reader.read()
          pending = reader.read()
        } else {
          await received
          pending = response
        }

        const reason = new Error('cancel request')
        const rejection = assert.rejects(pending, reason)

        await collectGarbage()
        controller.abort(reason)

        await rejection
      })
    }
  }
})
