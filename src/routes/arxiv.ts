import { Hono } from 'hono'
import { createGzip } from 'zlib'
import { prisma } from '../lib/prisma.js'

const arxivRoute = new Hono()

async function assertMember(projectId: string, userId: string) {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  })
  return member
}

// Known unsupported or problematic packages on arXiv
const ARXIV_UNSUPPORTED: Record<string, string> = {
  fontspec: 'requires XeLaTeX/LuaLaTeX — arXiv uses pdfLaTeX',
  xltxtra: 'XeLaTeX-only package',
  luacode: 'LuaLaTeX-only package',
  polyglossia: 'XeLaTeX-only (use babel instead)',
  unicode_math: 'XeLaTeX/LuaLaTeX-only',
  'unicode-math': 'XeLaTeX/LuaLaTeX-only',
  minted: 'requires --shell-escape, not allowed on arXiv',
  pythontex: 'requires Python execution, not allowed on arXiv',
  sagetex: 'requires Sage, not allowed on arXiv',
  epstopdf: 'usually auto-loaded, can cause issues — prefer PDF/PNG figures',
}

const ARXIV_OUTDATED: string[] = ['a4wide', 'doublespace', 'setspace']

// ── Analyse only (no archive) ─────────────────────────────────────────────────
arxivRoute.get('/:projectId/analyse', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('projectId')

  const member = await assertMember(projectId, userId)
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const files = await prisma.file.findMany({ where: { projectId } })
  const texFiles = files.filter((f) => f.name.endsWith('.tex'))

  const warnings: Array<{ file: string; line: number; type: 'error' | 'warning' | 'info'; message: string }> = []

  for (const file of texFiles) {
    const lines = file.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Check \usepackage lines
      const pkgMatch = line.match(/\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/)
      if (pkgMatch) {
        const packages = pkgMatch[1].split(',').map((p) => p.trim())
        for (const pkg of packages) {
          if (ARXIV_UNSUPPORTED[pkg]) {
            warnings.push({ file: file.name, line: i + 1, type: 'error', message: `Package '${pkg}': ${ARXIV_UNSUPPORTED[pkg]}` })
          } else if (ARXIV_OUTDATED.includes(pkg)) {
            warnings.push({ file: file.name, line: i + 1, type: 'warning', message: `Package '${pkg}' is outdated — consider a modern alternative` })
          }
        }
      }

      // Check for \include or \input with missing files
      const includeMatch = line.match(/\\(?:include|input)\{([^}]+)\}/)
      if (includeMatch) {
        const ref = includeMatch[1].replace(/\.tex$/, '') + '.tex'
        if (!files.some((f) => f.name === ref || f.name === includeMatch[1])) {
          warnings.push({ file: file.name, line: i + 1, type: 'warning', message: `Referenced file '${includeMatch[1]}' not found in project` })
        }
      }

      // Check for external bibliography (non-bib files)
      const bibMatch = line.match(/\\bibliography\{([^}]+)\}/)
      if (bibMatch) {
        const bibNames = bibMatch[1].split(',').map((b) => b.trim())
        for (const bibName of bibNames) {
          const bibFile = bibName.endsWith('.bib') ? bibName : bibName + '.bib'
          if (!files.some((f) => f.name === bibFile)) {
            warnings.push({ file: file.name, line: i + 1, type: 'info', message: `Bibliography '${bibName}': include the .bib file in your project` })
          }
        }
      }
    }
  }

  // Check for main file
  const mainFile = files.find((f) => f.isMain)
  if (!mainFile) {
    warnings.push({ file: '', line: 0, type: 'error', message: 'No main .tex file designated' })
  }

  // Suggest comment cleaning
  let commentLines = 0
  for (const file of texFiles) {
    const lines = file.content.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('%') && !trimmed.startsWith('%%')) commentLines++
    }
  }
  if (commentLines > 0) {
    warnings.push({ file: '', line: 0, type: 'info', message: `${commentLines} comment line${commentLines > 1 ? 's' : ''} found — arXiv recommends removing author comments before submission` })
  }

  return c.json({
    data: {
      warnings,
      fileCount: files.length,
      texFileCount: texFiles.length,
      commentLineCount: commentLines,
      ready: warnings.filter((w) => w.type === 'error').length === 0,
    },
  })
})

// ── Build archive (tar.gz via Node streams) ───────────────────────────────────

arxivRoute.post('/:projectId/archive', async (c) => {
  const { userId } = c.get('user') as { userId: string }
  const projectId = c.req.param('projectId')

  const member = await assertMember(projectId, userId)
  if (!member) return c.json({ data: null, error: 'Access denied' }, 403)

  const body = await c.req.json<{ cleanComments?: boolean }>().catch(() => ({}))
  const cleanComments = (body as { cleanComments?: boolean }).cleanComments ?? false

  const files = await prisma.file.findMany({ where: { projectId } })
  if (files.length === 0) return c.json({ data: null, error: 'Project has no files' }, 404)

  function stripComments(content: string): string {
    return content
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('%')
        if (idx === -1) return line
        // Keep %% and \% (escaped percent)
        for (let i = idx; i >= 0; i--) {
          if (line[i] === '%') {
            if (i === 0 || line[i - 1] !== '\\') {
              // Check for %% (separator line)
              if (line[i + 1] === '%') return line
              return line.slice(0, i).trimEnd()
            }
          }
        }
        return line
      })
      .join('\n')
  }

  // Build tar manually (POSIX ustar format)
  function pad(n: number, width: number, base = 8): string {
    return n.toString(base).padStart(width, '0')
  }

  function tarEntry(name: string, data: Buffer): Buffer {
    const nameBytes = Buffer.from(name.slice(0, 100), 'ascii')
    const header = Buffer.alloc(512, 0)
    nameBytes.copy(header, 0)
    Buffer.from(pad(0o100644, 7), 'ascii').copy(header, 100) // mode
    Buffer.from(pad(0, 7), 'ascii').copy(header, 108)         // uid
    Buffer.from(pad(0, 7), 'ascii').copy(header, 116)         // gid
    const sizeOctal = pad(data.length, 11)
    Buffer.from(sizeOctal, 'ascii').copy(header, 124)
    const mtime = Math.floor(Date.now() / 1000)
    Buffer.from(pad(mtime, 11), 'ascii').copy(header, 136)
    header[156] = 0x30 // '0' = regular file
    Buffer.from('ustar  \0', 'ascii').copy(header, 257)

    // Compute checksum
    Buffer.from('        ', 'ascii').copy(header, 148)
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += header[i]
    Buffer.from(pad(checksum, 6) + '\0 ', 'ascii').copy(header, 148)

    // Pad data to 512-byte boundary
    const paddedSize = Math.ceil(data.length / 512) * 512
    const padded = Buffer.alloc(paddedSize, 0)
    data.copy(padded, 0)

    return Buffer.concat([header, padded])
  }

  const tarParts: Buffer[] = []
  for (const file of files) {
    let content = file.content
    if (cleanComments && file.name.endsWith('.tex')) {
      content = stripComments(content)
    }
    const data = Buffer.from(content, 'utf8')
    tarParts.push(tarEntry(file.name, data))
  }
  // End-of-archive: two 512-byte zero blocks
  tarParts.push(Buffer.alloc(1024, 0))

  const tarBuffer = Buffer.concat(tarParts)

  // Gzip compress
  const compressed = await new Promise<Buffer>((resolve, reject) => {
    const gzip = createGzip()
    const chunks: Buffer[] = []
    gzip.on('data', (chunk: Buffer) => chunks.push(chunk))
    gzip.on('end', () => resolve(Buffer.concat(chunks)))
    gzip.on('error', reject)
    gzip.write(tarBuffer)
    gzip.end()
  })

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true } })
  const filename = `${(project?.title ?? 'project').replace(/[^a-z0-9_-]/gi, '_')}.tar.gz`

  return new Response(compressed, {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
})

export default arxivRoute
