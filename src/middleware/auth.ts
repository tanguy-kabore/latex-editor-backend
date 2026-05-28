import type { Context, Next } from 'hono'
import { verify } from 'jsonwebtoken'

export interface JwtPayload {
  userId: string
  email: string
  iat?: number
  exp?: number
}

const PUBLIC_ROUTES: Array<{ method: string; path: string }> = [
  { method: 'POST', path: '/api/auth/register' },
  { method: 'POST', path: '/api/auth/login' },
]

export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  const method = c.req.method
  const path = c.req.path

  // Only protect /api/* routes; let /health, /ws, etc. pass through
  if (!path.startsWith('/api')) {
    return next()
  }

  const isPublic = PUBLIC_ROUTES.some(
    (r) => r.method === method && path === r.path
  )

  if (isPublic) {
    return next()
  }

  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ data: null, error: 'Authorization token missing' }, 401)
  }

  const token = authHeader.slice(7)
  try {
    const secret = process.env.JWT_SECRET!
    const payload = verify(token, secret) as JwtPayload & { type?: string; projectId?: string }
    if (payload.type === 'share') {
      c.set('user', { userId: null, shareProjectId: payload.projectId })
    } else {
      c.set('user', { userId: payload.userId, email: payload.email })
    }
    return next()
  } catch {
    return c.json({ data: null, error: 'Invalid or expired token' }, 401)
  }
}
