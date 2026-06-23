import { createServer } from 'http'
import { Server } from 'socket.io'

const httpServer = createServer()
const io = new Server(httpServer, {
  path: '/',
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`)

  // Broadcast: new teacher added
  socket.on('teacher-added', (data) => {
    socket.broadcast.emit('teacher-added', data)
    console.log('Broadcast: teacher-added')
  })

  // Broadcast: teacher updated
  socket.on('teacher-updated', (data) => {
    socket.broadcast.emit('teacher-updated', data)
    console.log('Broadcast: teacher-updated')
  })

  // Broadcast: teacher deleted
  socket.on('teacher-deleted', (data) => {
    socket.broadcast.emit('teacher-deleted', data)
    console.log('Broadcast: teacher-deleted')
  })

  // Broadcast: teachers bulk replaced (import/demo)
  socket.on('teachers-replaced', (data) => {
    socket.broadcast.emit('teachers-replaced', data)
    console.log('Broadcast: teachers-replaced')
  })

  // Broadcast: schedule updated
  socket.on('schedule-updated', (data) => {
    socket.broadcast.emit('schedule-updated', data)
    console.log('Broadcast: schedule-updated')
  })

  // Broadcast: distribution results ready
  socket.on('results-ready', (data) => {
    socket.broadcast.emit('results-ready', data)
    console.log('Broadcast: results-ready')
  })

  // Broadcast: data reset
  socket.on('data-reset', () => {
    socket.broadcast.emit('data-reset')
    console.log('Broadcast: data-reset')
  })

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`)
  })
})

const PORT = 3003
httpServer.listen(PORT, () => {
  console.log(`Committee sync WebSocket server running on port ${PORT}`)
})

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0))
})