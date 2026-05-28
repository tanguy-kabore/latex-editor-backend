import { Hono } from 'hono'
import { sign } from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../lib/prisma.js'
import { supabaseAdmin } from '../lib/supabase.js'
import { getTemplateContent, type TemplateId } from '../lib/templates.js'

const projects = new Hono()

async function assertMember(
  projectId: string,
  userId: string,
  requiredRoles?: string[]
) {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  })
  if (!member) return null
  if (requiredRoles && !requiredRoles.includes(member.role)) return null
  return member
}

// ── List projects ────────────────────────────────────────────────────────────
// filter: all (default) | mine | shared | archived | trashed
projects.get('/', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const filter = c.req.query('filter') ?? 'all'

  let where: Record<string, unknown>

  if (filter === 'trashed') {
    where = { ownerId: userId, deletedAt: { not: null } }
  } else if (filter === 'archived') {
    where = { ownerId: userId, archivedAt: { not: null }, deletedAt: null }
  } else if (filter === 'mine') {
    where = { ownerId: userId, archivedAt: null, deletedAt: null }
  } else if (filter === 'shared') {
    where = {
      ownerId: { not: userId },
      members: { some: { userId } },
      deletedAt: null,
    }
  } else {
    // all: owned + member, not archived, not trashed
    where = {
      members: { some: { userId } },
      archivedAt: null,
      deletedAt: null,
    }
  }

  const list = await prisma.project.findMany({
    where,
    include: {
      _count: { select: { members: true } },
      compilations: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true, status: true },
      },
      files: { where: { isMain: true }, select: { name: true } },
    },
    orderBy: { updatedAt: 'desc' },
  })

  return c.json({ data: list })
})

// ── Create project ───────────────────────────────────────────────────────────
projects.post('/', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const body = await c.req.json<{ title: string; template?: TemplateId; templateId?: string }>()
  const { title, template = 'blank', templateId } = body ?? {}

  if (!title?.trim()) {
    return c.json({ data: null, error: 'title is required' }, 400)
  }

  // Create from a user/community template
  if (templateId) {
    const tmpl = await prisma.template.findUnique({
      where: { id: templateId },
      include: { files: true, sharedWith: true },
    })
    if (!tmpl) return c.json({ data: null, error: 'Template not found' }, 404)

    // Access check: public, owner, or shared with user
    const hasAccess =
      tmpl.isPublic ||
      tmpl.userId === userId ||
      tmpl.sharedWith.some((s) => s.userId === userId)
    if (!hasAccess) return c.json({ data: null, error: 'Access denied' }, 403)

    const project = await prisma.project.create({
      data: {
        title: title.trim(),
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
  }

  // Create from built-in template
  const content = getTemplateContent(template)
  const project = await prisma.project.create({
    data: {
      title: title.trim(),
      ownerId: userId,
      members: { create: { userId, role: 'OWNER' } },
      files: { create: { name: 'main.tex', content, isMain: true } },
    },
    include: { files: true, _count: { select: { members: true } } },
  })

  return c.json({ data: project }, 201)
})

// ── Get project ──────────────────────────────────────────────────────────────
projects.get('/:id', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('id')

  const member = await assertMember(projectId, userId)
  if (!member) return c.json({ data: null, error: 'Project not found or access denied' }, 404)

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      files: { select: { id: true, name: true, isMain: true, updatedAt: true } },
      members: {
        include: { user: { select: { id: true, email: true, name: true } } },
      },
      _count: { select: { members: true } },
    },
  })

  return c.json({ data: project })
})

// ── Rename project ───────────────────────────────────────────────────────────
projects.patch('/:id', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('id')
  const body = await c.req.json<{ title: string }>()

  const member = await assertMember(projectId, userId, ['OWNER'])
  if (!member) return c.json({ data: null, error: 'Only the owner can rename this project' }, 403)

  if (!body?.title?.trim()) {
    return c.json({ data: null, error: 'title is required' }, 400)
  }

  const project = await prisma.project.update({
    where: { id: projectId },
    data: { title: body.title.trim() },
    select: { id: true, title: true, updatedAt: true },
  })

  return c.json({ data: project })
})

// ── Soft-delete (trash) ──────────────────────────────────────────────────────
projects.delete('/:id', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('id')

  const member = await assertMember(projectId, userId, ['OWNER'])
  if (!member) return c.json({ data: null, error: 'Only the owner can delete this project' }, 403)

  await prisma.project.update({
    where: { id: projectId },
    data: { deletedAt: new Date() },
  })

  return c.json({ data: { success: true } })
})

// ── Permanent delete ─────────────────────────────────────────────────────────
projects.delete('/:id/permanent', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('id')

  const member = await assertMember(projectId, userId, ['OWNER'])
  if (!member) return c.json({ data: null, error: 'Only the owner can delete this project' }, 403)

  const { data: storageFiles } = await supabaseAdmin.storage.from('pdfs').list(projectId)
  if (storageFiles && storageFiles.length > 0) {
    await supabaseAdmin.storage.from('pdfs').remove(storageFiles.map((f) => `${projectId}/${f.name}`))
  }

  await prisma.project.delete({ where: { id: projectId } })
  return c.json({ data: { success: true } })
})

// ── Archive ──────────────────────────────────────────────────────────────────
projects.post('/:id/archive', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('id')

  const member = await assertMember(projectId, userId, ['OWNER'])
  if (!member) return c.json({ data: null, error: 'Only the owner can archive this project' }, 403)

  await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } })
  return c.json({ data: { success: true } })
})

// ── Unarchive ────────────────────────────────────────────────────────────────
projects.post('/:id/unarchive', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('id')

  const member = await assertMember(projectId, userId, ['OWNER'])
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  await prisma.project.update({ where: { id: projectId }, data: { archivedAt: null } })
  return c.json({ data: { success: true } })
})

// ── Restore from trash ───────────────────────────────────────────────────────
projects.post('/:id/restore', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('id')

  const member = await assertMember(projectId, userId, ['OWNER'])
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  await prisma.project.update({ where: { id: projectId }, data: { deletedAt: null } })
  return c.json({ data: { success: true } })
})

// ── Share link ───────────────────────────────────────────────────────────────
projects.post('/:id/share', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('id')

  const member = await assertMember(projectId, userId)
  if (!member) return c.json({ data: null, error: 'Project not found or access denied' }, 404)

  const token = sign(
    { projectId, role: 'VIEWER', type: 'share' },
    process.env.JWT_SECRET!,
    { expiresIn: '30d' }
  )

  const frontendUrl = process.env.FRONTEND_URL
  return c.json({ data: { shareUrl: `${frontendUrl}/shared/${token}` } })
})

// ── Add member ───────────────────────────────────────────────────────────────
projects.post('/:id/members', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('id')
  const body = await c.req.json<{ email: string; role?: 'EDITOR' | 'VIEWER' }>()

  const member = await assertMember(projectId, userId, ['OWNER', 'EDITOR'])
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const { email, role = 'EDITOR' } = body ?? {}
  if (!email) return c.json({ data: null, error: 'email is required' }, 400)

  const targetUser = await prisma.user.findUnique({ where: { email } })
  if (!targetUser) return c.json({ data: null, error: 'User not found' }, 404)

  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: targetUser.id } },
  })
  if (existing) return c.json({ data: null, error: 'User is already a member' }, 409)

  const newMember = await prisma.projectMember.create({
    data: { projectId, userId: targetUser.id, role },
    include: { user: { select: { id: true, email: true, name: true } } },
  })

  return c.json({ data: newMember }, 201)
})

// ── Store compiled PDF ───────────────────────────────────────────────────────
projects.post('/:id/pdf', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('id')

  const member = await assertMember(projectId, userId, ['OWNER', 'EDITOR'])
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const body = await c.req.json<{ pdf: string; log?: string }>()
  if (!body?.pdf) return c.json({ data: null, error: 'pdf is required' }, 400)

  const pdfBuffer = Buffer.from(body.pdf, 'base64')
  const jobId = uuidv4()

  await prisma.compilationJob.create({
    data: { id: jobId, projectId, status: 'SUCCESS', pdfData: pdfBuffer, log: body.log ?? '' },
  })

  return c.json({ data: { jobId } })
})

// ── Serve latest PDF ─────────────────────────────────────────────────────────
projects.get('/:id/pdf', async (c) => {
  const user = c.get('user') as { userId: string | null; shareProjectId?: string }
  const projectId = c.req.param('id')

  if (user.userId) {
    const member = await assertMember(projectId, user.userId)
    if (!member) return c.json({ data: null, error: 'Access denied' }, 403)
  } else if ((user as any).shareProjectId !== projectId) {
    return c.json({ data: null, error: 'Access denied' }, 403)
  }

  const latest = await prisma.compilationJob.findFirst({
    where: { projectId, status: 'SUCCESS', pdfData: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { pdfData: true },
  })

  if (!latest?.pdfData) {
    return c.json({ data: null, error: 'No compiled PDF found' }, 404)
  }

  return new Response(latest.pdfData as Buffer, {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline' },
  })
})

// ── Fork / Clone project ──────────────────────────────────────────────────────
projects.post('/:id/fork', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('id')

  const member = await assertMember(projectId, userId)
  if (!member) return c.json({ data: null, error: 'Project not found or access denied' }, 404)

  const original = await prisma.project.findUnique({
    where: { id: projectId },
    include: { files: true },
  })
  if (!original) return c.json({ data: null, error: 'Project not found' }, 404)

  const fork = await prisma.project.create({
    data: {
      title: `Copie de ${original.title}`,
      ownerId: userId,
      members: { create: { userId, role: 'OWNER' } },
      files: {
        create: original.files.map((f) => ({
          name: f.name,
          content: f.content,
          isMain: f.isMain,
        })),
      },
    },
    include: { files: true, _count: { select: { members: true } } },
  })

  return c.json({ data: fork }, 201)
})

export default projects
