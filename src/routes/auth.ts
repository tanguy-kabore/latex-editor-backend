import { Hono } from 'hono'
import { hash, compare } from 'bcryptjs'
import { sign } from 'jsonwebtoken'
import { prisma } from '../lib/prisma.js'

const auth = new Hono()

function signJwt(userId: string, email: string): string {
  return sign(
    { userId, email },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' }
  )
}

auth.post('/register', async (c) => {
  const body = await c.req.json<{ email: string; password: string; name: string }>()
  const { email, password, name } = body ?? {}

  if (!email || !password || !name) {
    return c.json({ data: null, error: 'email, password and name are required' }, 400)
  }
  if (password.length < 8) {
    return c.json({ data: null, error: 'Password must be at least 8 characters' }, 400)
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    return c.json({ data: null, error: 'Invalid email format' }, 400)
  }

  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    return c.json({ data: null, error: 'Email already in use' }, 409)
  }

  const passwordHash = await hash(password, 12)
  const user = await prisma.user.create({
    data: { email, passwordHash, name },
    select: { id: true, email: true, name: true },
  })

  const token = signJwt(user.id, user.email)
  return c.json({ data: { token, user } }, 201)
})

auth.post('/login', async (c) => {
  const body = await c.req.json<{ email: string; password: string }>()
  const { email, password } = body ?? {}

  if (!email || !password) {
    return c.json({ data: null, error: 'email and password are required' }, 400)
  }

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    return c.json({ data: null, error: 'Invalid credentials' }, 401)
  }

  const valid = await compare(password, user.passwordHash)
  if (!valid) {
    return c.json({ data: null, error: 'Invalid credentials' }, 401)
  }

  const token = signJwt(user.id, user.email)
  return c.json({
    data: { token, user: { id: user.id, email: user.email, name: user.name } },
  })
})

auth.get('/me', async (c) => {
  const { userId } = c.get('user') as { userId: string; email: string }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, createdAt: true },
  })
  if (!user) {
    return c.json({ data: null, error: 'User not found' }, 404)
  }
  return c.json({ data: user })
})

export default auth
