import * as Y from 'yjs'
import { setupWSConnection } from 'y-websocket/bin/utils'
import { prisma } from '../lib/prisma.js'
import type { IncomingMessage } from 'http'
import type { WebSocket } from 'ws'

interface RoomState {
  doc: Y.Doc
  clientCount: number
  flushTimer: ReturnType<typeof setTimeout> | null
}

const rooms = new Map<string, RoomState>()

async function flushRoomToDb(projectId: string, doc: Y.Doc): Promise<void> {
  try {
    const mainFile = await prisma.file.findFirst({
      where: { projectId, isMain: true },
    })
    if (!mainFile) return

    const yText = doc.getText(mainFile.name)
    const content = yText.toString()

    if (content.length > 0) {
      await prisma.file.update({
        where: { id: mainFile.id },
        data: { content },
      })
    }
  } catch (err) {
    console.error(`[yjs] Failed to flush room ${projectId} to DB:`, err)
  }
}

export function handleYjsConnection(
  ws: WebSocket,
  req: IncomingMessage,
  projectId: string
): void {
  if (!rooms.has(projectId)) {
    rooms.set(projectId, { doc: new Y.Doc(), clientCount: 0, flushTimer: null })
  }

  const room = rooms.get(projectId)!

  if (room.flushTimer) {
    clearTimeout(room.flushTimer)
    room.flushTimer = null
  }

  room.clientCount++

  setupWSConnection(ws, req, {
    docName: projectId,
    gc: true,
  })

  ws.on('close', () => {
    room.clientCount--

    if (room.clientCount <= 0) {
      room.clientCount = 0
      room.flushTimer = setTimeout(async () => {
        await flushRoomToDb(projectId, room.doc)
        if (room.clientCount === 0) {
          rooms.delete(projectId)
        }
        room.flushTimer = null
      }, 5000)
    }
  })
}
