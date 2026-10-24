const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readState, writeState, initialState, runQueue } = require('./bump-state')
const { isBumpPull } = require('./bump')

const request = version => ({ version, pr: '1300', issue: '1299' })
const pull = (number, version, pending = [], state = 'open') => ({
  number,
  title: `🎈 Add version ${version}`,
  body: writeState('Maintainer description.', initialState(version, pending)),
  state
})

function fixture (initial = []) {
  const pulls = structuredClone(initial)
  const created = []
  const updates = []
  const api = {
    list: async () => structuredClone(pulls),
    get: async number => structuredClone(pulls.find(pr => pr.number === number)),
    update: async (number, body) => {
      updates.push(number)
      pulls.find(pr => pr.number === number).body = body
    },
    create: async (next, state) => {
      const number = Math.max(0, ...pulls.map(pr => pr.number)) + 1
      const pr = { number, title: `🎈 Add version ${next.version}`, body: writeState('New PR.', state), state: 'open' }
      pulls.push(pr)
      created.push({ ...next, number })
      return { number }
    }
  }
  return {
    api,
    pulls,
    created,
    updates,
    run: (next, supported = ['26.2']) => runQueue({ api, request: next, supported }),
    state: number => readState(pulls.find(pr => pr.number === number).body)
  }
}

test('state updates preserve maintainer text and show queue links', () => {
  const state = initialState('26.3', [request('26.4')])
  const body = writeState('My notes.', state)
  assert.deepEqual(readState(body), state)
  assert.match(body, /My notes\./)
  assert.match(body, /- 26\.4 .*PR #1300/)
  const updated = writeState(`${body}\nMore notes.`, initialState('26.3'))
  assert.match(updated, /More notes\./)
  assert.equal((updated.match(/<WF_STATE>/g) || []).length, 1)
  assert.equal((updated.match(/<!-- BUMP_QUEUE -->/g) || []).length, 1)
  assert.doesNotMatch(updated, /- 26\.4/)
})

test('creates the initial PR with an empty state', async () => {
  const f = fixture()
  await f.run(request('26.3'))
  assert.deepEqual(f.state(1), initialState('26.3'))
  assert.equal(f.created[0].pr, '1300')
})

test('queues multiple releases in numeric order, deduplicating deliveries', async () => {
  const f = fixture([pull(1, '26.3')])
  for (const version of ['26.10', '26.5', '26.4', '26.4', '26.3', '26.2']) await f.run(request(version))
  assert.deepEqual(f.state(1).pending.map(r => r.version), ['26.4', '26.5', '26.10'])
  assert.equal(f.created.length, 0)
})

test('merging advances one version and carries the queue; closing skips and continues', async () => {
  const f = fixture([pull(1, '26.3', [request('26.4'), request('26.5')])])
  f.pulls[0].state = 'closed'
  await f.run(null, ['26.2', '26.3'])
  assert.deepEqual(f.state(2), initialState('26.4', [request('26.5')], 1))
  assert.equal(f.state(1).successor, 2)
  assert.match(f.pulls[0].body, /Queue handed off to #2/)
  f.pulls[1].state = 'closed'
  await f.run(null, ['26.2', '26.3']) // 26.4 was skipped, so is absent from main.
  assert.deepEqual(f.state(3), initialState('26.5', [], 2))
  assert.equal(f.state(2).successor, 3)
  await f.run(request('26.4'), ['26.2', '26.3'])
  assert.equal(f.created.length, 2)
  assert.deepEqual(f.state(3).pending, [])
})

test('repeated close events and duplicate dispatches do not advance twice', async () => {
  const f = fixture([pull(1, '26.3', [request('26.4'), request('26.5')], 'closed')])
  await f.run()
  await f.run()
  await f.run(request('26.4'))
  assert.equal(f.created.length, 1)
  assert.deepEqual(f.state(2).pending, [request('26.5')])
})

test('a dispatch after closure preserves old and new requests before advancing', async () => {
  const f = fixture([pull(1, '26.3', [request('26.4')], 'closed')])
  await f.run(request('26.5'))
  assert.equal(f.created[0].version, '26.4')
  assert.deepEqual(f.state(2).pending, [request('26.5')])
  await f.run(request('26.6'))
  assert.deepEqual(f.state(2).pending.map(r => r.version), ['26.5', '26.6'])
})

test('an empty queue or already supported queued version creates nothing', async () => {
  const f = fixture([pull(1, '26.3', [request('26.4')], 'closed')])
  await f.run(null, ['26.2', '26.3', '26.4'])
  await f.run()
  assert.equal(f.created.length, 0)
})

test('failed creation retains the complete queue for retry', async () => {
  const f = fixture([pull(1, '26.3', [request('26.4')], 'closed')])
  const create = f.api.create
  f.api.create = async () => { throw new Error('Push failed') }
  await assert.rejects(f.run(request('26.5')), /Push failed/)
  assert.deepEqual(f.state(1).pending.map(r => r.version), ['26.4', '26.5'])
  assert.equal(f.state(1).successor, null)
  f.api.create = create
  await f.run()
  assert.deepEqual(f.state(2).pending, [request('26.5')])
})

test('retry discovers the successor when creation succeeded but its response was lost', async () => {
  const f = fixture([pull(1, '26.3', [request('26.4'), request('26.5')], 'closed')])
  const create = f.api.create
  f.api.create = async (...args) => {
    await create(...args)
    throw new Error('Connection lost')
  }
  await assert.rejects(f.run(), /Connection lost/)
  assert.equal(f.state(1).successor, null)
  await f.run(request('26.6'))
  assert.equal(f.created.length, 1)
  assert.equal(f.state(1).successor, 2)
  assert.deepEqual(f.state(2).pending.map(r => r.version), ['26.5', '26.6'])
})

test('retry repairs predecessor update failure without replacing successor state', async () => {
  const f = fixture([pull(1, '26.3', [request('26.4'), request('26.5')], 'closed')])
  const update = f.api.update
  f.api.update = async (number, body) => {
    if (readState(body).successor) throw new Error('Update failed')
    await update(number, body)
  }
  await assert.rejects(f.run(), /Update failed/)
  f.api.update = update
  f.pulls[1].body += '\nContributor notes.'
  await f.run(request('26.6'))
  assert.equal(f.created.length, 1)
  assert.equal(f.state(1).successor, 2)
  assert.match(f.pulls[1].body, /Contributor notes\./)
  assert.deepEqual(f.state(2).pending.map(r => r.version), ['26.5', '26.6'])
})

test('failed state write creates nothing and a repeated dispatch can be saved', async () => {
  const f = fixture([pull(1, '26.3', [], 'closed')])
  const update = f.api.update
  f.api.update = async () => { throw new Error('Update failed') }
  await assert.rejects(f.run(request('26.4')), /Update failed/)
  assert.equal(f.created.length, 0)
  f.api.update = update
  await f.run(request('26.4'))
  assert.equal(f.created.length, 1)
})

test('bootstraps a legacy PR even if its title was renamed', async () => {
  const f = fixture([{
    number: 77,
    title: '🎈 Support 26.2 and fix various issues',
    body: 'This automated PR sets up the relevant boilerplate for Minecraft version 26.2.',
    state: 'closed'
  }])
  await f.run(request('26.3'))
  assert.equal(f.state(77).successor, 78)
  assert.deepEqual(f.state(78), initialState('26.3', [], 77))
})

test('malformed state fails without writes or creation', async () => {
  const pr = pull(1, '26.3')
  pr.body = '<!-- <WF_STATE>{broken}</WF_STATE> -->'
  const f = fixture([pr])
  await assert.rejects(f.run(request('26.4')), SyntaxError)
  assert.equal(f.created.length, 0)
  assert.equal(f.updates.length, 0)
})

test('an older PR without a body can acquire queue state from its title', async () => {
  const f = fixture([{ number: 1, title: '🎈 Add version 26.3', body: null, state: 'open' }])
  await f.run(request('26.4'))
  assert.deepEqual(f.state(1), initialState('26.3', [request('26.4')]))
})

test('only the repository bump branch targeting main is eligible', () => {
  const pr = { head: { ref: 'bump', repo: { full_name: 'owner/repo' } }, base: { ref: 'main' }, title: '🎈 Add version 26.3' }
  assert.equal(isBumpPull(pr, 'owner/repo'), true)
  assert.equal(isBumpPull(pr, 'fork/repo'), false)
  assert.equal(isBumpPull({ ...pr, head: { ...pr.head, ref: 'fix' } }, 'owner/repo'), false)
  assert.equal(isBumpPull({ ...pr, base: { ref: 'bump' } }, 'owner/repo'), false)
})
