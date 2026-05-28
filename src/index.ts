import * as http from 'http'
import { getRequestListener } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { verify } from 'jsonwebtoken'
import { WebSocketServer } from 'ws'
import { authMiddleware } from './middleware/auth.js'
import authRoutes from './routes/auth.js'
import projectRoutes from './routes/projects.js'
import fileRoutes from './routes/files.js'
import compileRoutes from './routes/compile.js'
import templateRoutes from './routes/templates.js'
import chatRoutes from './routes/chat.js'
import gitRoutes from './routes/git.js'
import exportRoutes from './routes/export.js'
import arxivRoutes from './routes/arxiv.js'
import { handleYjsConnection } from './ws/yjs.js'

const app = new Hono()

app.use('*', logger())

app.use(
  '*',
  cors({
    origin: process.env.FRONTEND_URL ?? '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
)

app.use('*', authMiddleware)

app.route('/api/auth', authRoutes)
app.route('/api/projects', projectRoutes)
app.route('/api/projects', fileRoutes)
app.route('/api/compile', compileRoutes)
app.route('/api/templates', templateRoutes)
app.route('/api/projects', chatRoutes)
app.route('/api/projects', gitRoutes)
app.route('/api/export', exportRoutes)
app.route('/api/arxiv', arxivRoutes)

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))
app.get('/', (c) => c.json({ name: 'latex-editor-backend', version: '1.0.0' }))
app.onError((err, c) => {
  console.error('[server] unhandled error:', err)
  return c.json({ data: null, error: err.message ?? 'Internal server error' }, 500)
})

// Create HTTP server with Hono's request handler
const requestListener = getRequestListener(app.fetch)
const server = http.createServer(requestListener)

// WebSocket server for Yjs (noServer mode — we handle the upgrade ourselves)
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const rawUrl = req.url ?? '/'
  const url = new URL(rawUrl, 'http://localhost')
  const match = url.pathname.match(/^\/ws\/(.+)$/)

  if (!match) {
    socket.destroy()
    return
  }

  const projectId = decodeURIComponent(match[1])
  const token = url.searchParams.get('token')

  if (token) {
    try {
      verify(token, process.env.JWT_SECRET!)
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    console.log(`[ws] client connected to room: ${projectId}`)
    handleYjsConnection(ws as any, req, projectId)
  })
})

const port = parseInt(process.env.PORT ?? '3000', 10)

server.listen(port, () => {
  console.log(`[server] Listening on http://localhost:${port}`)
})

export default app
