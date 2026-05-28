import { Hono } from 'hono'
import { sign } from 'jsonwebtoken'
import { prisma } from '../lib/prisma.js'

const templates = new Hono()

const TEMPLATE_INCLUDE = {
  user: { select: { id: true, name: true, email: true } },
  _count: { select: { files: true, sharedWith: true } },
} as const

// ── List templates ───────────────────────────────────────────────────────────
// filter: all (public + mine + shared-with-me) | mine | public
templates.get('/', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const filter = c.req.query('filter') ?? 'all'

  let where: Record<string, unknown>

  if (filter === 'mine') {
    where = { userId }
  } else if (filter === 'public') {
    where = { isPublic: true }
  } else {
    // all: public + mine + shared with me
    where = {
      OR: [
        { isPublic: true },
        { userId },
        { sharedWith: { some: { userId } } },
      ],
    }
  }

  const list = await prisma.template.findMany({
    where,
    include: TEMPLATE_INCLUDE,
    orderBy: { updatedAt: 'desc' },
  })

  return c.json({ data: list })
})

// ── Create template ──────────────────────────────────────────────────────────
// Body: { title, description?, category?, isPublic?, files, fromProjectId? }
// If fromProjectId is provided, files are copied from that project.
templates.post('/', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const body = await c.req.json<{
    title: string
    description?: string
    category?: string
    isPublic?: boolean
    fromProjectId?: string
    files?: Array<{ name: string; content: string; isMain: boolean }>
  }>()

  const { title, description, category, isPublic = false, fromProjectId, files } = body ?? {}

  if (!title?.trim()) return c.json({ data: null, error: 'title is required' }, 400)

  let templateFiles: Array<{ name: string; content: string; isMain: boolean }> = []

  if (fromProjectId) {
    // Copy files from an existing project
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: fromProjectId, userId } },
    })
    if (!member) return c.json({ data: null, error: 'Project not found or access denied' }, 403)

    const projectFiles = await prisma.file.findMany({
      where: { projectId: fromProjectId },
      select: { name: true, content: true, isMain: true },
    })
    templateFiles = projectFiles
  } else if (files && files.length > 0) {
    templateFiles = files
  } else {
    return c.json({ data: null, error: 'Either fromProjectId or files is required' }, 400)
  }

  const template = await prisma.template.create({
    data: {
      title: title.trim(),
      description: description?.trim() ?? null,
      category: category?.trim() ?? null,
      isPublic,
      userId,
      files: { create: templateFiles },
    },
    include: {
      ...TEMPLATE_INCLUDE,
      files: { select: { id: true, name: true, isMain: true } },
    },
  })

  return c.json({ data: template }, 201)
})

// ── Get template ─────────────────────────────────────────────────────────────
templates.get('/:id', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const templateId = c.req.param('id')

  const tmpl = await prisma.template.findUnique({
    where: { id: templateId },
    include: {
      ...TEMPLATE_INCLUDE,
      files: true,
      sharedWith: { include: { user: { select: { id: true, email: true, name: true } } } },
    },
  })

  if (!tmpl) return c.json({ data: null, error: 'Template not found' }, 404)

  const hasAccess =
    tmpl.isPublic ||
    tmpl.userId === userId ||
    tmpl.sharedWith.some((s) => s.userId === userId)

  if (!hasAccess) return c.json({ data: null, error: 'Access denied' }, 403)

  return c.json({ data: tmpl })
})

// ── Update template metadata ─────────────────────────────────────────────────
templates.patch('/:id', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const templateId = c.req.param('id')
  const body = await c.req.json<{
    title?: string
    description?: string
    category?: string
    isPublic?: boolean
  }>()

  const tmpl = await prisma.template.findUnique({ where: { id: templateId } })
  if (!tmpl || tmpl.userId !== userId) return c.json({ data: null, error: 'Not found or access denied' }, 403)

  const updated = await prisma.template.update({
    where: { id: templateId },
    data: {
      ...(body.title !== undefined && { title: body.title.trim() }),
      ...(body.description !== undefined && { description: body.description.trim() }),
      ...(body.category !== undefined && { category: body.category.trim() }),
      ...(body.isPublic !== undefined && { isPublic: body.isPublic }),
    },
    include: TEMPLATE_INCLUDE,
  })

  return c.json({ data: updated })
})

// ── Delete template ──────────────────────────────────────────────────────────
templates.delete('/:id', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const templateId = c.req.param('id')

  const tmpl = await prisma.template.findUnique({ where: { id: templateId } })
  if (!tmpl || tmpl.userId !== userId) return c.json({ data: null, error: 'Not found or access denied' }, 403)

  await prisma.template.delete({ where: { id: templateId } })
  return c.json({ data: { success: true } })
})

// ── Share template with a user ───────────────────────────────────────────────
templates.post('/:id/share', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const templateId = c.req.param('id')
  const body = await c.req.json<{ email?: string; shareLink?: boolean }>()

  const tmpl = await prisma.template.findUnique({ where: { id: templateId } })
  if (!tmpl || tmpl.userId !== userId) return c.json({ data: null, error: 'Not found or access denied' }, 403)

  // Option A: share link (anyone with the link can view & use)
  if (body.shareLink) {
    const token = sign(
      { templateId, type: 'template-share' },
      process.env.JWT_SECRET!,
      { expiresIn: '30d' }
    )
    const frontendUrl = process.env.FRONTEND_URL
    return c.json({ data: { shareUrl: `${frontendUrl}/templates/${templateId}?token=${token}` } })
  }

  // Option B: share with a specific user by email
  if (!body.email) return c.json({ data: null, error: 'email is required' }, 400)

  const targetUser = await prisma.user.findUnique({ where: { email: body.email } })
  if (!targetUser) return c.json({ data: null, error: 'User not found' }, 404)

  if (targetUser.id === userId) return c.json({ data: null, error: 'Cannot share with yourself' }, 400)

  await prisma.templateShare.upsert({
    where: { templateId_userId: { templateId, userId: targetUser.id } },
    update: {},
    create: { templateId, userId: targetUser.id },
  })

  return c.json({ data: { success: true, sharedWith: { email: targetUser.email, name: targetUser.name } } })
})

// ── Remove share ─────────────────────────────────────────────────────────────
templates.delete('/:id/share/:targetUserId', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const templateId = c.req.param('id')
  const targetUserId = c.req.param('targetUserId')

  const tmpl = await prisma.template.findUnique({ where: { id: templateId } })
  if (!tmpl || tmpl.userId !== userId) return c.json({ data: null, error: 'Not found or access denied' }, 403)

  await prisma.templateShare.deleteMany({ where: { templateId, userId: targetUserId } })
  return c.json({ data: { success: true } })
})

// ── Use template → create project ────────────────────────────────────────────
templates.post('/:id/use', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const templateId = c.req.param('id')
  const body = await c.req.json<{ title: string }>()

  if (!body?.title?.trim()) return c.json({ data: null, error: 'title is required' }, 400)

  const tmpl = await prisma.template.findUnique({
    where: { id: templateId },
    include: { files: true, sharedWith: true },
  })
  if (!tmpl) return c.json({ data: null, error: 'Template not found' }, 404)

  const hasAccess =
    tmpl.isPublic ||
    tmpl.userId === userId ||
    tmpl.sharedWith.some((s) => s.userId === userId)
  if (!hasAccess) return c.json({ data: null, error: 'Access denied' }, 403)

  const project = await prisma.project.create({
    data: {
      title: body.title.trim(),
      ownerId: userId,
      members: { create: { userId, role: 'OWNER' } },
      files: {
        create: tmpl.files.map((f) => ({
          name: f.name,
          content: f.content,
          isMain: f.isMain,
        })),
      },
    },
    include: { files: true, _count: { select: { members: true } } },
  })

  return c.json({ data: project }, 201)
})

export default templates
