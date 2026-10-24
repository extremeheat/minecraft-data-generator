const cp = require('child_process')
const fs = require('fs')
const { runQueue, writeState } = require('./bump-state')

const exec = (...args) => {
  console.log('$ git', ...args)
  cp.execFileSync('git', args, { stdio: 'inherit' })
}

const generateBody = ({ version, issue, pr }) => `
This automated PR sets up the relevant boilerplate for Minecraft version ${version}.

Links:
- Issue: ${issue ? `https://github.com/PrismarineJS/minecraft-data/issues/${issue}` : 'N/A'}
- PR: ${pr ? `https://github.com/PrismarineJS/minecraft-data/pull/${pr}` : 'N/A'}

If the PR is passing, it will automatically send the generated artifacts to PrismarineJS/minecraft-data${pr ? `#${pr}` : ''}.

If the PR is **not** passing:
* You can help contribute to this PR by opening a PR against this <code>bump</code> branch instead of <code>main</code>.
`

function validateRequest (request) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(request.version)) throw new Error('Invalid Minecraft version')
  for (const field of ['pr', 'issue']) {
    if (request[field] && !/^\d+$/.test(request[field])) throw new Error(`Invalid minecraft-data ${field} number`)
  }
}

function isBumpBranch (pr, repository) {
  return pr.head?.ref === 'bump' && pr.head?.repo?.full_name === repository &&
    pr.base?.ref === 'main'
}

function isBumpPull (pr, repository) {
  return isBumpBranch(pr, repository) && pr.title.startsWith('🎈')
}

// Use the paginated pulls endpoint: search results can lag behind PR creation,
// which matters when recovering a handoff, and must not filter by token owner.
async function listBumpPulls (repository) {
  const pulls = []
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ state: 'all', base: 'main', head: `${repository.split('/')[0]}:bump`, per_page: '100', page: String(page) })
    const response = await fetch(`https://api.github.com/repos/${repository}/pulls?${params}`, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    })
    if (!response.ok) throw new Error(`Cannot list bump PRs: ${response.status}`)
    const batch = await response.json()
    pulls.push(...batch.filter(pr => isBumpBranch(pr, repository)))
    if (batch.length < 100) return pulls
  }
}

module.exports = async ([newVersion], helpers) => {
  const gh = require('gh-helpers')()
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error('GITHUB_REPOSITORY is required')
  const request = newVersion
    ? { version: newVersion, pr: process.env.MCDATA_PULL_NO || '', issue: process.env.MCDATA_ISSUE_NO || '' }
    : null
  if (request) validateRequest(request)

  try {
    await runQueue({
      supported: require('../../versions.json'),
      request,
      api: {
        list: async () => (await listBumpPulls(repository)).filter(pr => isBumpPull(pr, repository)),
        get: number => gh.getPullRequest(number),
        update: (number, body) => gh.updatePull(number, { body }),
        create: async (next, state) => {
          validateRequest(next)
          // Never reset a branch that still has an open PR with contributor work.
          if ((await listBumpPulls(repository)).some(pr => pr.state === 'open')) throw new Error('A bump PR is already open')
          require('../../tools/newVersion')(next.version)
          exec('checkout', '-B', 'bump')
          exec('config', 'user.name', 'github-actions[bot]')
          exec('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
          exec('add', 'mc', 'versions.json')
          exec('commit', '-m', `Add version ${next.version}`)
          exec('push', 'origin', 'bump', '--force')
          const pr = await gh.createPullRequest(`🎈 Add version ${next.version}`, writeState(generateBody(next), state), 'bump', 'main')
          console.log('Pull request created:', pr.url)
          return pr
        }
      }
    })
  } catch (error) {
    await helpers.reply('Error bumping version: ' + error.message)
    throw error
  }
}

module.exports.isBumpPull = isBumpPull

if (require.main === module) {
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {}
  const closed = process.env.GITHUB_EVENT_NAME === 'pull_request_target' && event.action === 'closed' &&
    isBumpPull(event.pull_request, process.env.GITHUB_REPOSITORY)
  const version = process.argv[2] || process.env.MC_VERSION
  if (closed || version) {
    module.exports([closed ? undefined : version], { reply: console.error }).catch(error => {
      console.error(error)
      process.exitCode = 1
    })
  } else {
    console.error('Usage: node bump.js <newVersion> (or a bump PR closed event)')
    process.exitCode = 1
  }
}
