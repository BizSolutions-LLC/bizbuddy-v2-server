// src/config/socket.js
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

let io;

/**
 * Initialize Socket.io server with authentication and room management
 */
function init(server) {
  io = new Server(server, {
    cors: {
      origin: [
        "http://localhost:19006",
        "https://mybizbuddy.co",
        "http://localhost:3000",
        "http://localhost:3001"
      ],
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // Authentication middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    
    // Allow connection without auth for backward compatibility
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded.id;
        socket.companyId = decoded.companyId;
        socket.role = decoded.role;
      } catch (err) {
        console.warn('Invalid token, allowing connection without auth');
      }
    }
    next();
  });

  io.on('connection', (socket) => {
    if (socket.userId) {
      console.log(`✅ User connected: ${socket.userId} (${socket.id})`);

      // Join user-specific room
      socket.join(`user:${socket.userId}`);
      
      // Join company room
      socket.join(`company:${socket.companyId}`);
      
      // Join role-based rooms for management
      if (['admin', 'superadmin', 'supervisor'].includes(socket.role)) {
        socket.join(`company:${socket.companyId}:management`);
      }
    } else {
      console.log('Client connected (no auth):', socket.id);
    }

    socket.on('disconnect', () => {
      if (socket.userId) {
        console.log(`❌ User disconnected: ${socket.userId}`);
      } else {
        console.log('Client disconnected:', socket.id);
      }
    });
  });

  return io;
}

/**
 * Send notification to specific user
 */
function notifyUser(userId, notification) {
  if (!io) return;
  io.to(`user:${userId}`).emit('notification', notification);
}

/**
 * Send notification to all management in a company
 */
function notifyManagement(companyId, notification) {
  if (!io) return;
  io.to(`company:${companyId}:management`).emit('notification', notification);
}

/**
 * Send notification to entire company
 */
function notifyCompany(companyId, notification) {
  if (!io) return;
  io.to(`company:${companyId}`).emit('notification', notification);
}

/**
 * Get Socket.io instance
 */
function getIO() {
  if (!io) {
    throw new Error('Socket.io not initialized!');
  }
  return io;
}

module.exports = {
  init,
  notifyUser,
  notifyManagement,
  notifyCompany,
  getIO,
};