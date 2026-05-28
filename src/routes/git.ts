import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'

const git = new Hono()

async function assertMember(projectId: string, userId: string, requiredRoles?: string[]) {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  })
  if (!member) return null
  if (requiredRoles && !requiredRoles.includes(member.role)) return null
  return member
}

// ── GitHub Tree API push ──────────────────────────────────────────────────────

async function githubRequest(
  url: string,
  method: string,
  token: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

async function gitlabRequest(
  url: string,
  method: string,
  token: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, {
    method,
    headers: {
      'PRIVATE-TOKEN': token,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

function parseGithubRepo(repoUrl: string): { owner: string; repo: string } | null {
  const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/)
  if (!m) return null
  return { owner: m[1], repo: m[2] }
}

function parseGitlabProject(repoUrl: string, instanceUrl?: string): string | null {
  const base = instanceUrl ?? 'https://gitlab.com'
  const prefix = base.replace(/\/$/, '') + '/'
  if (!repoUrl.startsWith(prefix)) return null
  return encodeURIComponent(repoUrl.slice(prefix.length).replace(/\.git$/, ''))
}

// ── Push ─────────────────────────────────────────────────────────────────────

git.post('/:id/git/push', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('id')

  const member = await assertMember(projectId, userId, ['OWNER', 'EDITOR'])
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const body = await c.req.json<{
    provider: 'github' | 'gitlab'
    repoUrl: string
    branch: string
    token: string
    message: string
    instanceUrl?: string
  }>()

  const { provider, repoUrl, branch, token, message, instanceUrl } = body ?? {}
  if (!provider || !repoUrl || !branch || !token || !message) {
    return c.json({ data: null, error: 'provider, repoUrl, branch, token and message are required' }, 400)
  }

  const files = await prisma.file.findMany({ where: { projectId } })

  if (provider === 'github') {
    const parsed = parseGithubRepo(repoUrl)
    if (!parsed) return c.json({ data: null, error: 'Invalid GitHub URL' }, 400)
    const { owner, repo } = parsed
    const apiBase = `https://api.github.com/repos/${owner}/${repo}`

    // Get current branch ref
    const refRes = await githubRequest(`${apiBase}/git/ref/heads/${branch}`, 'GET', token)
    let parentSha: string | null = null
    let baseTreeSha: string | null = null

    if (refRes.ok) {
      parentSha = (refRes.data as { object: { sha: string } }).object.sha
      const commitRes = await githubRequest(`${apiBase}/git/commits/${parentSha}`, 'GET', token)
      if (commitRes.ok) {
        baseTreeSha = (commitRes.data as { tree: { sha: string } }).tree.sha
      }
    }

    // Create blobs for each file
    const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = []
    for (const file of files) {
      const blobRes = await githubRequest(`${apiBase}/git/blobs`, 'POST', token, {
        content: Buffer.from(file.content).toString('base64'),
        encoding: 'base64',
      })
      if (!blobRes.ok) {
        return c.json({ data: null, error: `Failed to create blob for ${file.name}: ${JSON.stringify(blobRes.data)}` }, 500)
      }
      treeItems.push({
        path: file.name,
        mode: '100644',
        type: 'blob',
        sha: (blobRes.data as { sha: string }).sha,
      })
    }

    // Create tree
    const treeBody: Record<string, unknown> = { tree: treeItems }
    if (baseTreeSha) treeBody.base_tree = baseTreeSha
    const treeRes = await githubRequest(`${apiBase}/git/trees`, 'POST', token, treeBody)
    if (!treeRes.ok) {
      return c.json({ data: null, error: `Failed to create tree: ${JSON.stringify(treeRes.data)}` }, 500)
    }
    const newTreeSha = (treeRes.data as { sha: string }).sha

    // Create commit
    const commitBody: Record<string, unknown> = { message, tree: newTreeSha }
    if (parentSha) commitBody.parents = [parentSha]
    const commitRes2 = await githubRequest(`${apiBase}/git/commits`, 'POST', token, commitBody)
    if (!commitRes2.ok) {
      return c.json({ data: null, error: `Failed to create commit: ${JSON.stringify(commitRes2.data)}` }, 500)
    }
    const newCommitSha = (commitRes2.data as { sha: string }).sha

    // Update or create ref
    if (refRes.ok) {
      const updateRes = await githubRequest(`${apiBase}/git/refs/heads/${branch}`, 'PATCH', token, { sha: newCommitSha, force: false })
      if (!updateRes.ok) {
        return c.json({ data: null, error: `Failed to update ref: ${JSON.stringify(updateRes.data)}` }, 500)
      }
    } else {
      const createRes = await githubRequest(`${apiBase}/git/refs`, 'POST', token, { ref: `refs/heads/${branch}`, sha: newCommitSha })
      if (!createRes.ok) {
        return c.json({ data: null, error: `Failed to create ref: ${JSON.stringify(createRes.data)}` }, 500)
      }
    }

    return c.json({ data: { commitSha: newCommitSha, branch, fileCount: files.length } })

  } else if (provider === 'gitlab') {
    const gitlabBase = instanceUrl ? instanceUrl.replace(/\/$/, '') : 'https://gitlab.com'
    const projectPath = parseGitlabProject(repoUrl, instanceUrl)
    if (!projectPath) return c.json({ data: null, error: 'Invalid GitLab URL' }, 400)
    const apiBase = `${gitlabBase}/api/v4/projects/${projectPath}`

    const actions = files.map((f) => ({
      action: 'create',
      file_path: f.name,
      content: f.content,
      encoding: 'text',
    }))

    // Try create, fall back to update for existing files
    const commitRes = await gitlabRequest(`${apiBase}/repository/commits`, 'POST', token, {
      branch,
      commit_message: message,
      actions,
      force: true,
    })

    if (!commitRes.ok) {
      // Try with update action for all files
      const updateActions = files.map((f) => ({
        action: 'update',
        file_path: f.name,
        content: f.content,
        encoding: 'text',
      }))
      const retryRes = await gitlabRequest(`${apiBase}/repository/commits`, 'POST', token, {
        branch,
        commit_message: message,
        actions: updateActions,
      })
      if (!retryRes.ok) {
        return c.json({ data: null, error: `GitLab commit failed: ${JSON.stringify(retryRes.data)}` }, 500)
      }
      return c.json({ data: { commitSha: (retryRes.data as { id: string }).id, branch, fileCount: files.length } })
    }

    return c.json({ data: { commitSha: (commitRes.data as { id: string }).id, branch, fileCount: files.length } })
  }

  return c.json({ data: null, error: 'Unknown provider' }, 400)
})

// ── Pull ─────────────────────────────────────────────────────────────────────

git.post('/:id/git/pull', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('id')

  const member = await assertMember(projectId, userId, ['OWNER', 'EDITOR'])
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const body = await c.req.json<{
    provider: 'github' | 'gitlab'
    repoUrl: string
    branch: string
    token: string
    instanceUrl?: string
  }>()

  const { provider, repoUrl, branch, token, instanceUrl } = body ?? {}
  if (!provider || !repoUrl || !branch || !token) {
    return c.json({ data: null, error: 'provider, repoUrl, branch and token are required' }, 400)
  }

  let pulledFiles: Array<{ name: string; content: string }> = []

  if (provider === 'github') {
    const parsed = parseGithubRepo(repoUrl)
    if (!parsed) return c.json({ data: null, error: 'Invalid GitHub URL' }, 400)
    const { owner, repo } = parsed
    const apiBase = `https://api.github.com/repos/${owner}/${repo}`

    // Get tree recursively
    const treeRes = await githubRequest(`${apiBase}/git/trees/${branch}?recursive=1`, 'GET', token)
    if (!treeRes.ok) return c.json({ data: null, error: `Failed to fetch tree: ${JSON.stringify(treeRes.data)}` }, 500)

    const treeItems = (treeRes.data as { tree: Array<{ path: string; type: string; sha: string }> }).tree
    const blobs = treeItems.filter(
      (i) => i.type === 'blob' && /\.(tex|bib|bst|sty|cls|txt|bbx|cbx|def|cfg|eps)$/i.test(i.path)
    )

    for (const blob of blobs) {
      const blobRes = await githubRequest(`${apiBase}/git/blobs/${blob.sha}`, 'GET', token)
      if (!blobRes.ok) continue
      const b = blobRes.data as { content: string; encoding: string }
      const content = b.encoding === 'base64' ? Buffer.from(b.content.replace(/\n/g, ''), 'base64').toString('utf8') : b.content
      pulledFiles.push({ name: blob.path, content })
    }

  } else if (provider === 'gitlab') {
    const gitlabBase = instanceUrl ? instanceUrl.replace(/\/$/, '') : 'https://gitlab.com'
    const projectPath = parseGitlabProject(repoUrl, instanceUrl)
    if (!projectPath) return c.json({ data: null, error: 'Invalid GitLab URL' }, 400)
    const apiBase = `${gitlabBase}/api/v4/projects/${projectPath}`

    const treeRes = await gitlabRequest(`${apiBase}/repository/tree?ref=${encodeURIComponent(branch)}&recursive=true&per_page=100`, 'GET', token)
    if (!treeRes.ok) return c.json({ data: null, error: `Failed to fetch tree: ${JSON.stringify(treeRes.data)}` }, 500)

    const items = (treeRes.data as Array<{ path: string; type: string }>) ?? []
    const blobs = items.filter(
      (i) => i.type === 'blob' && /\.(tex|bib|bst|sty|cls|txt|bbx|cbx|def|cfg|eps)$/i.test(i.path)
    )

    for (const blob of blobs) {
      const fileRes = await gitlabRequest(
        `${apiBase}/repository/files/${encodeURIComponent(blob.path)}?ref=${encodeURIComponent(branch)}`,
        'GET',
        token
      )
      if (!fileRes.ok) continue
      const f = fileRes.data as { content: string; encoding: string }
      const content = f.encoding === 'base64' ? Buffer.from(f.content, 'base64').toString('utf8') : f.content
      pulledFiles.push({ name: blob.path, content })
    }
  } else {
    return c.json({ data: null, error: 'Unknown provider' }, 400)
  }

  if (pulledFiles.length === 0) {
    return c.json({ data: null, error: 'No LaTeX files found in repository' }, 404)
  }

  // Upsert pulled files into the project
  const existingFiles = await prisma.file.findMany({ where: { projectId } })
  const existingByName = new Map(existingFiles.map((f) => [f.name, f]))

  const ops = pulledFiles.map(async ({ name, content }) => {
    const existing = existingByName.get(name)
    if (existing) {
      return prisma.file.update({ where: { id: existing.id }, data: { content } })
    } else {
      return prisma.file.create({ data: { projectId, name, content, isMain: name === 'main.tex' } })
    }
  })

  await Promise.all(ops)

  return c.json({ data: { fileCount: pulledFiles.length, files: pulledFiles.map((f) => f.name) } })
})

export default git
