import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'

const files = new Hono()

async function assertMember(projectId: string, userId: string, requiredRoles?: string[]) {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  })
  if (!member) return null
  if (requiredRoles && !requiredRoles.includes(member.role)) return null
  return member
}

files.get('/:projectId/files-full', async (c) => {
  const user = c.get('user') as { userId: string | null; shareProjectId?: string }
  const projectId = c.req.param('projectId')

  if (user.userId) {
    const member = await assertMember(projectId, user.userId)
    if (!member) return c.json({ data: null, error: 'Access denied' }, 403)
  } else if ((user as any).shareProjectId !== projectId) {
    return c.json({ data: null, error: 'Access denied' }, 403)
  }

  const projectFiles = await prisma.file.findMany({
    where: { projectId },
    select: { id: true, name: true, isMain: true, content: true },
    orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
  })

  return c.json({ data: projectFiles })
})

files.get('/:projectId/files', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('projectId')

  const member = await assertMember(projectId, userId)
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const projectFiles = await prisma.file.findMany({
    where: { projectId },
    select: { id: true, name: true, isMain: true, updatedAt: true },
    orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
  })

  return c.json({ data: projectFiles })
})

files.post('/:projectId/files', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('projectId')

  const member = await assertMember(projectId, userId, ['OWNER', 'EDITOR'])
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const body = await c.req.json<{ name: string; content?: string }>()
  if (!body?.name?.trim()) return c.json({ data: null, error: 'name is required' }, 400)

  const name = body.name.trim()
  const existing = await prisma.file.findFirst({ where: { projectId, name } })
  if (existing) return c.json({ data: null, error: 'File with this name already exists' }, 409)

  const file = await prisma.file.create({
    data: { projectId, name, content: body.content ?? '', isMain: false },
    select: { id: true, name: true, isMain: true, updatedAt: true },
  })

  return c.json({ data: file }, 201)
})

files.get('/:projectId/files/:fileId', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('projectId')
  const fileId = c.req.param('fileId')

  const member = await assertMember(projectId, userId)
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const file = await prisma.file.findFirst({
    where: { id: fileId, projectId },
  })

  if (!file) return c.json({ data: null, error: 'File not found' }, 404)

  return c.json({ data: file })
})

files.put('/:projectId/files/:fileId', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('projectId')
  const fileId = c.req.param('fileId')

  const member = await assertMember(projectId, userId, ['OWNER', 'EDITOR'])
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const body = await c.req.json<{ content: string }>()
  if (body?.content === undefined) return c.json({ data: null, error: 'content is required' }, 400)

  const file = await prisma.file.findFirst({ where: { id: fileId, projectId } })
  if (!file) return c.json({ data: null, error: 'File not found' }, 404)

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } })

  // Only create a revision if content actually changed
  const lastRevision = await prisma.fileRevision.findFirst({
    where: { fileId },
    orderBy: { createdAt: 'desc' },
    select: { content: true },
  })
  const contentChanged = !lastRevision || lastRevision.content !== body.content

  const [updated] = await prisma.$transaction(async (tx) => {
    const updatedFile = await tx.file.update({
      where: { id: fileId },
      data: { content: body.content },
      select: { id: true, name: true, isMain: true, updatedAt: true },
    })

    if (contentChanged) {
      await tx.fileRevision.create({
        data: {
          fileId,
          projectId,
          userId,
          userName: user?.name ?? 'Inconnu',
          content: body.content,
        },
      })

      // Keep only the last 100 revisions per file
      const old = await tx.fileRevision.findMany({
        where: { fileId },
        orderBy: { createdAt: 'desc' },
        skip: 100,
        select: { id: true },
      })
      if (old.length > 0) {
        await tx.fileRevision.deleteMany({ where: { id: { in: old.map((r) => r.id) } } })
      }
    }

    return [updatedFile]
  })

  return c.json({ data: updated })
})

// GET /:projectId/files/:fileId/revisions — list revisions (no content)
files.get('/:projectId/files/:fileId/revisions', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('projectId')
  const fileId = c.req.param('fileId')

  const member = await assertMember(projectId, userId)
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const file = await prisma.file.findFirst({ where: { id: fileId, projectId } })
  if (!file) return c.json({ data: null, error: 'File not found' }, 404)

  const revisions = await prisma.fileRevision.findMany({
    where: { fileId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, userId: true, userName: true, createdAt: true },
  })

  return c.json({ data: revisions })
})

// GET /:projectId/files/:fileId/revisions/:revId — get single revision with content
files.get('/:projectId/files/:fileId/revisions/:revId', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('projectId')
  const fileId = c.req.param('fileId')
  const revId = c.req.param('revId')

  const member = await assertMember(projectId, userId)
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const revision = await prisma.fileRevision.findFirst({
    where: { id: revId, fileId, projectId },
  })
  if (!revision) return c.json({ data: null, error: 'Revision not found' }, 404)

  return c.json({ data: revision })
})

files.patch('/:projectId/files/:fileId', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('projectId')
  const fileId = c.req.param('fileId')

  const member = await assertMember(projectId, userId, ['OWNER', 'EDITOR'])
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const body = await c.req.json<{ name: string }>()
  if (!body?.name?.trim()) return c.json({ data: null, error: 'name is required' }, 400)

  const file = await prisma.file.findFirst({ where: { id: fileId, projectId } })
  if (!file) return c.json({ data: null, error: 'File not found' }, 404)

  const name = body.name.trim()
  const existing = await prisma.file.findFirst({ where: { projectId, name, NOT: { id: fileId } } })
  if (existing) return c.json({ data: null, error: 'File with this name already exists' }, 409)

  const updated = await prisma.file.update({
    where: { id: fileId },
    data: { name },
    select: { id: true, name: true, isMain: true, updatedAt: true },
  })

  return c.json({ data: updated })
})

files.delete('/:projectId/files/:fileId', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('projectId')
  const fileId = c.req.param('fileId')

  const member = await assertMember(projectId, userId, ['OWNER', 'EDITOR'])
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const file = await prisma.file.findFirst({ where: { id: fileId, projectId } })
  if (!file) return c.json({ data: null, error: 'File not found' }, 404)

  if (file.isMain) {
    return c.json({ data: null, error: 'Cannot delete the main file' }, 400)
  }

  await prisma.file.delete({ where: { id: fileId } })

  return c.json({ data: { success: true } })
})

files.post('/:projectId/import', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('projectId')

  const member = await assertMember(projectId, userId, ['OWNER', 'EDITOR'])
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const body = await c.req.json<{ files: Array<{ name: string; content: string; isMain: boolean }> }>()
  if (!Array.isArray(body?.files) || body.files.length === 0) {
    return c.json({ data: null, error: 'files array is required' }, 400)
  }

  // Ensure exactly one main file
  const mainCount = body.files.filter((f) => f.isMain).length
  if (mainCount === 0) body.files[0].isMain = true
  else if (mainCount > 1) body.files.forEach((f, i) => { f.isMain = i === 0 })

  // Replace all existing files with the imported set
  await prisma.file.deleteMany({ where: { projectId } })

  const created = await Promise.all(
    body.files.map((f) =>
      prisma.file.create({
        data: { projectId, name: f.name.trim(), content: f.content, isMain: f.isMain },
        select: { id: true, name: true, isMain: true, updatedAt: true },
      })
    )
  )

  return c.json({ data: created }, 201)
})

export default files
