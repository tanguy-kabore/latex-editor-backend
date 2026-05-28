import { Hono } from 'hono'
import { spawn } from 'child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join, sep } from 'path'
import { tmpdir } from 'os'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../lib/prisma.js'

const exportRoute = new Hono()

async function assertMember(projectId: string, userId: string) {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  })
  return member
}

function runPandoc(args: string[], cwd: string): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('pandoc', args, { cwd })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve({ exitCode: -1, stderr: 'timeout' }) }, 60000)
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, stderr }) })
  })
}

exportRoute.post('/:projectId', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('projectId')

  const member = await assertMember(projectId, userId)
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const body = await c.req.json<{ format: 'html' | 'docx' | 'markdown' }>()
  const { format } = body ?? {}
  if (!['html', 'docx', 'markdown'].includes(format)) {
    return c.json({ data: null, error: 'format must be html, docx, or markdown' }, 400)
  }

  // Check pandoc availability
  const pandocCheck = await new Promise<boolean>((resolve) => {
    const child = spawn('pandoc', ['--version'])
    child.on('close', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
  if (!pandocCheck) {
    return c.json({ data: null, error: 'Pandoc is not installed on this server. Please install pandoc to use this feature.' }, 503)
  }

  const files = await prisma.file.findMany({ where: { projectId } })
  const mainFile = files.find((f) => f.isMain) ?? files.find((f) => f.name.endsWith('.tex'))
  if (!mainFile) return c.json({ data: null, error: 'No .tex file found' }, 404)

  const jobId = uuidv4()
  const tmpDir = join(tmpdir(), `export-${jobId}`)
  mkdirSync(tmpDir, { recursive: true })

  try {
    // Write all project files to temp dir
    for (const file of files) {
      const filePath = join(tmpDir, file.name)
      const dirPart = filePath.substring(0, filePath.lastIndexOf(sep))
      if (dirPart !== tmpDir) mkdirSync(dirPart, { recursive: true })
      writeFileSync(filePath, file.content, 'utf8')
    }

    const inputFile = join(tmpDir, mainFile.name)
    const extMap = { html: '.html', docx: '.docx', markdown: '.md' }
    const outputFile = join(tmpDir, `output${extMap[format]}`)

    const pandocFormat = format === 'markdown' ? 'markdown' : format
    const args = [inputFile, '-f', 'latex', '-t', pandocFormat, '-o', outputFile, '--standalone']

    const result = await runPandoc(args, tmpDir)

    if (!existsSync(outputFile)) {
      return c.json({ data: null, error: `Pandoc conversion failed: ${result.stderr.slice(0, 500)}` }, 500)
    }

    const outputData = readFileSync(outputFile)
    const mimeMap = { html: 'text/html', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', markdown: 'text/markdown' }
    const mime = mimeMap[format]
    const filename = `${mainFile.name.replace(/\.tex$/, '')}${extMap[format]}`

    return new Response(outputData, {
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* cleanup best-effort */ }
  }
})

export default exportRoute
