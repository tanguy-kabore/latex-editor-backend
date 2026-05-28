import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'

const chat = new Hono()

async function assertMember(projectId: string, userId: string) {
  return prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  })
}

// GET /api/projects/:id/chat?cursor=<lastId>&limit=50
chat.get('/:id/chat', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('id')

  const member = await assertMember(projectId, userId)
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const cursor = c.req.query('cursor')
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 100)

  const messages = await prisma.chatMessage.findMany({
    where: {
      projectId,
      ...(cursor ? { createdAt: { gt: new Date(cursor) } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })

  return c.json({ data: messages })
})

// POST /api/projects/:id/chat
chat.post('/:id/chat', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('id')

  const member = await assertMember(projectId, userId)
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const body = await c.req.json<{ text: string }>()
  if (!body?.text?.trim()) return c.json({ data: null, error: 'text is required' }, 400)

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } })
  if (!user) return c.json({ data: null, error: 'User not found' }, 404)

  const message = await prisma.chatMessage.create({
    data: {
      projectId,
      userId,
      userName: user.name,
      text: body.text.trim(),
    },
  })

  return c.json({ data: message }, 201)
})

export default chat
