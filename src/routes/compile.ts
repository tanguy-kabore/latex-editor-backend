import { Hono } from 'hono'
import { spawn } from 'child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { v4 as uuidv4 } from 'uuid'
import { supabaseAdmin } from '../lib/supabase.js'
import { prisma } from '../lib/prisma.js'

const compile = new Hono()

interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

function runPdflatex(tmpDir: string, mainFile: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const args = [
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-output-directory',
      tmpDir,
      mainFile,
    ]

    const child = spawn('pdflatex', args, {
      cwd: tmpDir,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const killTimer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      } catch {
        // already dead
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // already dead
        }
      }, 2000)
    }, 30000)

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      resolve({
        exitCode: timedOut ? -1 : (code ?? -1),
        stdout,
        stderr,
        timedOut,
      })
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + '\n' + err.message,
        timedOut: false,
      })
    })
  })
}

interface LatexError {
  line: number | null
  message: string
}

function parseLatexLog(log: string): { errors: LatexError[]; warnings: string[] } {
  const lines = log.split('\n')
  const errors: LatexError[] = []
  const warnings: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('!')) {
      const message = lines[i + 1]?.trim() ?? line.trim()
      let lineNumber: number | null = null

      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        const match = lines[j].match(/^l\.(\d+)/)
        if (match) {
          lineNumber = parseInt(match[1], 10)
          break
        }
      }

      errors.push({ line: lineNumber, message })
      i += 1
    } else if (
      line.includes('Warning:') &&
      (line.includes('LaTeX Warning') || line.includes('Package Warning') || line.includes('Class Warning'))
    ) {
      warnings.push(line.trim())
    }
  }

  return { errors, warnings }
}

compile.post('/:projectId', async (c) => {
  const user = c.get('user') as { userId: string | null; shareProjectId?: string }
  const projectId = c.req.param('projectId')

  if (user.userId) {
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: user.userId } },
    })
    if (!member || member.role === 'VIEWER') {
      return c.json({ data: null, error: 'Access denied' }, 403)
    }
  } else if (user.shareProjectId !== projectId) {
    return c.json({ data: null, error: 'Access denied' }, 403)
  }

  const projectFiles = await prisma.file.findMany({ where: { projectId } })
  if (projectFiles.length === 0) {
    return c.json({ data: null, error: 'No files found in project' }, 404)
  }

  const jobId = uuidv4()
  const tmpDir = join('/tmp', jobId)
  mkdirSync(tmpDir, { recursive: true })

  await prisma.compilationJob.create({
    data: { id: jobId, projectId, status: 'RUNNING' },
  })

  try {
    for (const file of projectFiles) {
      const filePath = join(tmpDir, file.name)
      mkdirSync(join(filePath, '..'), { recursive: true })
      writeFileSync(filePath, file.content, 'utf-8')
    }

    const mainFile = projectFiles.find((f) => f.isMain)?.name ?? 'main.tex'
    const result = await runPdflatex(tmpDir, mainFile)

    if (result.timedOut) {
      await prisma.compilationJob.update({
        where: { id: jobId },
        data: { status: 'TIMEOUT', log: 'Compilation timed out after 30 seconds.' },
      })
      return c.json({
        data: null,
        error: 'Compilation timed out after 30 seconds',
      }, 408)
    }

    const baseName = mainFile.replace(/\.tex$/, '')
    const logPath = join(tmpDir, `${baseName}.log`)
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : result.stdout

    const { errors, warnings } = parseLatexLog(log)

    if (result.exitCode !== 0 && errors.length === 0) {
      errors.push({ line: null, message: 'Compilation failed. Check the log for details.' })
    }

    let pdfUrl: string | null = null

    if (result.exitCode === 0) {
      const pdfPath = join(tmpDir, `${baseName}.pdf`)
      if (existsSync(pdfPath)) {
        const pdfBuffer = readFileSync(pdfPath)
        const storagePath = `${projectId}/${jobId}.pdf`

        const { error: uploadError } = await supabaseAdmin.storage
          .from('pdfs')
          .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true })

        if (!uploadError) {
          const { data: signedData } = await supabaseAdmin.storage
            .from('pdfs')
            .createSignedUrl(storagePath, 3600)
          pdfUrl = signedData?.signedUrl ?? null
        }
      }
    }

    const status = result.exitCode === 0 ? 'SUCCESS' : 'ERROR'

    await prisma.compilationJob.update({
      where: { id: jobId },
      data: { status, pdfUrl, log },
    })

    return c.json({
      data: { pdfUrl, errors, warnings, log, jobId },
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

export default compile
