const cp = require('child_process')
const { runQueue, writeState } = require('./bump-state')

const git = (...args) => {
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
  return pr.headBranch === 'bump' && pr.headRepo === repository && pr.targetBranch === 'main'
}

function isBumpPull (pr, repository) {
  return isBumpBranch(pr, repository) && pr.title.startsWith('🎈')
}

module.exports = async ([newVersion], helpers) => {
  const gh = require('gh-helpers')()
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error('GITHUB_REPOSITORY is required')
  const listBumpPulls = async () => (await gh.listPullRequests({
    state: 'all', head: `${repository.split('/')[0]}:bump`, base: 'main'
  })).filter(pr => isBumpBranch(pr, repository))
  const request = newVersion
    ? { version: newVersion, pr: process.env.MCDATA_PULL_NO || '', issue: process.env.MCDATA_ISSUE_NO || '' }
    : null
  if (request) validateRequest(request)

  try {
    await runQueue({
      supported: require('../../versions.json'),
      request,
      api: {
        list: async () => (await listBumpPulls()).filter(pr => isBumpPull(pr, repository)),
        get: number => gh.getPullRequest(number),
        update: (number, body) => gh.updatePull(number, { body }),
        create: async (next, state) => {
          validateRequest(next)
          // Never reset a branch that still has an open PR with contributor work.
          if ((await listBumpPulls()).some(pr => pr.state === 'open')) throw new Error('A bump PR is already open')
          require('../../tools/newVersion')(next.version)
          git('checkout', '-B', 'bump')
          git('config', 'user.name', 'github-actions[bot]')
          git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
          git('add', 'mc', 'versions.json')
          git('commit', '-m', `Add version ${next.version}`)
          git('push', 'origin', 'bump', '--force')
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
  const args = process.argv.slice(2)
  if (args.length === 1) {
    module.exports([args[0] === '--advance' ? undefined : args[0]], { reply: console.error }).catch(error => {
      console.error(error)
      process.exitCode = 1
    })
  } else {
    console.error('Usage: node bump.js <newVersion> | --advance')
    process.exitCode = 1
  }
}
