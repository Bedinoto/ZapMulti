import express from "express";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WAMessageKey,
  WAMessageContent,
  proto
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizeJid(jid: string): string {
  if (!jid) return jid;
  if (jid.includes('@g.us')) return jid;
  const [user] = jid.split('@');
  const [userId] = user.split(':');
  return `${userId}@s.whatsapp.net`;
}

async function startServer() {
  console.log("Starting server script...");
  const db = new Database("whatsapp_v2.db");
  console.log("Database connected.");

  // Initialize Database
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT,
      last_message_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      assigned_to TEXT,
      is_group INTEGER DEFAULT 0,
      session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      sender_id TEXT,
      sender_name TEXT,
      text TEXT,
      type TEXT, -- 'incoming' or 'outgoing'
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT, -- 'sent', 'delivered', 'read'
      session_id TEXT,
      FOREIGN KEY(contact_id) REFERENCES contacts(id)
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      role TEXT, -- 'admin', 'agent'
      status TEXT DEFAULT 'offline'
    );

    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT DEFAULT 'disconnected',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Insert default admin if no agents exist
    INSERT OR IGNORE INTO agents (id, name, role, status) VALUES ('agent_1', 'Admin Agent', 'admin', 'online');
  `);

  // Migration: Add session_id if missing from existing tables
  try { db.prepare("ALTER TABLE contacts ADD COLUMN session_id TEXT").run(); } catch (e) {}
  try { db.prepare("ALTER TABLE messages ADD COLUMN session_id TEXT").run(); } catch (e) {}
  try { db.prepare("ALTER TABLE contacts ADD COLUMN unread_count INTEGER DEFAULT 0").run(); } catch (e) {}

  // Migration: Normalize existing JIDs
  const contactsToMerge = db.prepare("SELECT id, unread_count FROM contacts WHERE id LIKE '%:%@s.whatsapp.net'").all();
  for (const contact of contactsToMerge as any[]) {
    const normalized = normalizeJid(contact.id);
    if (normalized !== contact.id) {
      try {
        // Update messages to point to the normalized JID
        db.prepare("UPDATE messages SET contact_id = ? WHERE contact_id = ?").run(normalized, contact.id);
        db.prepare("UPDATE messages SET sender_id = ? WHERE sender_id = ?").run(normalized, contact.id);
        
        // Check if normalized contact exists
        const exists = db.prepare("SELECT id FROM contacts WHERE id = ?").get(normalized);
        if (exists) {
          // Merge unread_count
          db.prepare("UPDATE contacts SET unread_count = unread_count + ? WHERE id = ?").run(contact.unread_count || 0, normalized);
          // Delete the old one
          db.prepare("DELETE FROM contacts WHERE id = ?").run(contact.id);
        } else {
          // Rename the old one
          db.prepare("UPDATE contacts SET id = ? WHERE id = ?").run(normalized, contact.id);
        }
      } catch (e) {
        console.error("Error merging contact:", contact.id, e);
      }
    }
  }

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  app.use(express.json());

  // WebSocket handling
  const clients = new Set<WebSocket>();
  wss.on("connection", (ws) => {
    console.log("New WebSocket client connected.");
    clients.add(ws);
    // Send current connection status for all sessions
    sessionStatus.forEach((status, sessionId) => {
      ws.send(JSON.stringify({ 
        type: "AUTH_STATE", 
        sessionId, 
        payload: { status, qr: sessionQR.get(sessionId) } 
      }));
    });
    ws.on("close", () => {
      console.log("WebSocket client disconnected.");
      clients.delete(ws);
    });
  });

  const broadcast = (data: any) => {
    const message = JSON.stringify(data);
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  // WhatsApp Baileys Integration
  const sessions = new Map<string, any>();
  const sessionStatus = new Map<string, string>();
  const sessionQR = new Map<string, string | null>();
  const sessionRetries = new Map<string, number>();

  async function connectToWhatsApp(sessionId: string = 'default') {
    try {
      console.log(`Initializing WhatsApp connection for session: ${sessionId}...`);
      const authPath = path.join(__dirname, `auth_info_${sessionId}`);
      const { state, saveCreds } = await useMultiFileAuthState(authPath);
      
      let version;
      try {
        const fetched = await fetchLatestBaileysVersion();
        version = fetched.version;
      } catch (e) {
        version = [2, 3000, 1015901307];
      }

      const sock = makeWASocket({
        version,
        printQRInTerminal: sessionId === 'default',
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        logger: pino({ level: 'silent' }),
        browser: ["ZapMulti", "Chrome", "1.0.0"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000,
        generateHighQualityLinkPreview: true,
      });

      sessions.set(sessionId, sock);
      sessionStatus.set(sessionId, "initializing");
      broadcast({ type: "AUTH_STATE", sessionId, payload: { status: "initializing", qr: null } });

      const cleanup = () => {
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('creds.update');
        sock.ev.removeAllListeners('messages.upsert');
        if (sessions.get(sessionId) === sock) {
          sessions.delete(sessionId);
        }
      };

      sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (connection) console.log(`Session ${sessionId} connection update: ${connection}`);
        if (lastDisconnect?.error) console.log(`Session ${sessionId} disconnect error:`, lastDisconnect.error);

        if (qr) {
          const qrData = await QRCode.toDataURL(qr);
          sessionQR.set(sessionId, qrData);
          sessionStatus.set(sessionId, "qr_ready");
          broadcast({ type: "AUTH_STATE", sessionId, payload: { status: "qr_ready", qr: qrData } });
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const errorMsg = lastDisconnect?.error?.message || "";
          const errorData = (lastDisconnect?.error as any)?.data;
          const isRestartRequired = errorMsg.toLowerCase().includes('restart required') || 
                                   errorMsg.toLowerCase().includes('qr refs attempts ended') ||
                                   errorData?.attrs?.code === '515';
          
          console.log(`Connection ${sessionId} closed. Status: ${statusCode}, Error: ${errorMsg}, Data:`, errorData);

          sessionStatus.set(sessionId, "disconnected");
          sessionQR.set(sessionId, null);

          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          if (statusCode === DisconnectReason.loggedOut) {
            cleanup();
            console.log(`Session ${sessionId} logged out. Clearing...`);
            if (fs.existsSync(authPath)) {
              fs.rmSync(authPath, { recursive: true, force: true });
            }
            db.prepare("UPDATE connections SET status = 'disconnected' WHERE id = ?").run(sessionId);
            broadcast({ type: "AUTH_STATE", sessionId, payload: { status: "logged_out" } });
          } else if (shouldReconnect) {
            cleanup();
            const isTimeout = statusCode === DisconnectReason.timedOut || statusCode === 408 || isRestartRequired;
            const retries = sessionRetries.get(sessionId) || 0;
            // If it's a timeout or restart required, retry faster
            const delay = isTimeout ? 1000 : Math.min(Math.pow(2, retries) * 1000, 30000);
            
            console.log(`Reconnecting session ${sessionId} in ${delay}ms... (Reason: ${isTimeout ? 'Timeout/Restart' : statusCode})`);
            
            sessionRetries.set(sessionId, isTimeout ? 0 : retries + 1);
            setTimeout(() => connectToWhatsApp(sessionId), delay);
          }

          broadcast({ type: "AUTH_STATE", sessionId, payload: { status: sessionStatus.get(sessionId) } });
        } else if (connection === 'open') {
          console.log(`WhatsApp connection ${sessionId} opened successfully`);
          sessionStatus.set(sessionId, "connected");
          sessionQR.set(sessionId, null);
          sessionRetries.set(sessionId, 0);
          db.prepare("UPDATE connections SET status = 'connected' WHERE id = ?").run(sessionId);
          broadcast({ type: "AUTH_STATE", sessionId, payload: { status: "connected" } });
        }
      });

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('messages.upsert', async (m: any) => {
        if (m.type === 'notify') {
          for (const msg of m.messages) {
            if (msg.message) {
              const remoteJid = msg.key.remoteJid;
              if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) continue;
              
              const sender = normalizeJid(remoteJid);
              
              // Ignore messages from self (Notes to Self)
              const ownJid = normalizeJid(sock.user?.id || '');
              if (sender === ownJid) continue;

              const isGroup = sender.endsWith('@g.us');
              if (isGroup) continue;

              const text = msg.message.conversation || 
                           msg.message.extendedTextMessage?.text || 
                           (msg.message.imageMessage ? "📷 Foto" : 
                            msg.message.videoMessage ? "🎥 Vídeo" : 
                            msg.message.audioMessage ? "🎵 Áudio" : 
                            msg.message.documentMessage ? "📄 Documento" : "Mensagem de mídia");

              const timestamp = msg.messageTimestamp;
              const now = Math.floor(Date.now() / 1000);
              if (now - timestamp > 60) continue;

              const name = msg.pushName || sender.split('@')[0];
              const type = msg.key.fromMe ? 'outgoing' : 'incoming';
              const unreadIncrement = type === 'incoming' ? 1 : 0;

              db.prepare(`
                INSERT INTO contacts (id, name, last_message_at, is_group, session_id, unread_count)
                VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET 
                  name = CASE WHEN contacts.name = contacts.id THEN excluded.name ELSE contacts.name END,
                  last_message_at = CURRENT_TIMESTAMP,
                  session_id = excluded.session_id,
                  unread_count = unread_count + excluded.unread_count
              `).run(sender, name, isGroup ? 1 : 0, sessionId, unreadIncrement);

              const msgId = msg.key.id;
              db.prepare(`
                INSERT OR IGNORE INTO messages (id, contact_id, sender_id, sender_name, text, type, status, session_id)
                VALUES (?, ?, ?, ?, ?, ?, 'received', ?)
              `).run(msgId, sender, sender, name, text, type, sessionId);

              broadcast({
                type: "NEW_MESSAGE",
                sessionId,
                payload: {
                  id: msgId,
                  contact_id: sender,
                  sender_id: sender,
                  sender_name: name,
                  text,
                  type,
                  timestamp: new Date().toISOString()
                }
              });
            }
          }
        }
      });
    } catch (error) {
      console.error(`Error in connection ${sessionId}:`, error);
    }
  }

  // Initialize existing connections
  const existingConnections = db.prepare("SELECT id FROM connections").all();
  if (existingConnections.length === 0) {
    db.prepare("INSERT INTO connections (id, name, status) VALUES ('default', 'Conexão Principal', 'disconnected')").run();
    connectToWhatsApp('default');
  } else {
    existingConnections.forEach((conn: any) => {
      connectToWhatsApp(conn.id);
    });
  }

  // API Endpoints
  app.get("/api/contacts", (req, res) => {
    const contacts = db.prepare("SELECT * FROM contacts ORDER BY last_message_at DESC").all();
    res.json(contacts);
  });

  app.get("/api/agents", (req, res) => {
    const agents = db.prepare("SELECT * FROM agents").all();
    res.json(agents);
  });

  app.post("/api/agents", (req, res) => {
    const { name, role } = req.body;
    const id = "agent_" + Date.now();
    try {
      db.prepare("INSERT INTO agents (id, name, role, status) VALUES (?, ?, ?, 'offline')").run(id, name, role);
      const newAgent = { id, name, role, status: 'offline' };
      broadcast({ type: "AGENT_CREATED", payload: newAgent });
      res.json(newAgent);
    } catch (error) {
      res.status(500).json({ error: "Failed to create agent" });
    }
  });

  app.delete("/api/agents/:id", (req, res) => {
    const { id } = req.params;
    if (id === 'agent_1') return res.status(400).json({ error: "Cannot delete default admin" });
    try {
      db.prepare("DELETE FROM agents WHERE id = ?").run(id);
      // Unassign contacts
      db.prepare("UPDATE contacts SET assigned_to = NULL WHERE assigned_to = ?").run(id);
      broadcast({ type: "AGENT_DELETED", payload: { id } });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete agent" });
    }
  });

  app.get("/api/messages/:contactId", (req, res) => {
    const { contactId } = req.params;
    db.prepare("UPDATE contacts SET unread_count = 0 WHERE id = ?").run(contactId);
    const messages = db.prepare("SELECT * FROM messages WHERE contact_id = ? ORDER BY timestamp ASC").all(contactId);
    res.json(messages);
  });

  app.get("/api/connections", (req, res) => {
    const connections = db.prepare("SELECT * FROM connections").all();
    const enriched = connections.map((conn: any) => ({
      ...conn,
      status: sessionStatus.get(conn.id) || conn.status,
      qr: sessionQR.get(conn.id) || null
    }));
    res.json(enriched);
  });

  app.post("/api/connections", (req, res) => {
    const { name } = req.body;
    const id = `conn_${Date.now()}`;
    db.prepare("INSERT INTO connections (id, name, status) VALUES (?, ?, 'disconnected')").run(id, name);
    connectToWhatsApp(id);
    res.json({ success: true, id });
  });

  app.delete("/api/connections/:id", async (req, res) => {
    const { id } = req.params;
    try {
      const sock = sessions.get(id);
      if (sock) {
        try { await sock.logout(); } catch (e) { sock.end(undefined); }
        sessions.delete(id);
      }
      
      const authPath = path.join(__dirname, `auth_info_${id}`);
      if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true });
      }
      
      db.prepare("DELETE FROM connections WHERE id = ?").run(id);
      sessionStatus.delete(id);
      sessionQR.delete(id);
      
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false });
    }
  });

  app.post("/api/send", async (req, res) => {
    const { contactId, text, media, sessionId = 'default' } = req.body;
    
    const sock = sessions.get(sessionId);
    if (!sock || sessionStatus.get(sessionId) !== "connected") {
      return res.status(400).json({ success: false, error: "WhatsApp not connected for this session" });
    }

    try {
      let sentMsg;
      let messageText = text;

      if (media) {
        const { data, mimeType, fileName } = media;
        const buffer = Buffer.from(data, 'base64');

        if (mimeType.startsWith('image/')) {
          sentMsg = await sock.sendMessage(contactId, { image: buffer, caption: text });
          messageText = text || "📷 Foto";
        } else if (mimeType.startsWith('video/')) {
          sentMsg = await sock.sendMessage(contactId, { video: buffer, caption: text });
          messageText = text || "🎥 Vídeo";
        } else if (mimeType.startsWith('audio/')) {
          sentMsg = await sock.sendMessage(contactId, { audio: buffer });
          messageText = text || "🎵 Áudio";
        } else {
          sentMsg = await sock.sendMessage(contactId, { document: buffer, fileName: fileName || 'document', mimetype: mimeType, caption: text });
          messageText = text || `📄 ${fileName || 'Documento'}`;
        }
      } else {
        sentMsg = await sock.sendMessage(contactId, { text });
      }

      const messageId = sentMsg.key.id;

      const insertMsg = db.prepare(`
        INSERT INTO messages (id, contact_id, text, type, status, session_id)
        VALUES (?, ?, ?, 'outgoing', 'sent', ?)
      `);
      insertMsg.run(messageId, contactId, messageText, sessionId);

      broadcast({
        type: "NEW_MESSAGE",
        sessionId,
        payload: { id: messageId, contact_id: contactId, text: messageText, type: "outgoing", timestamp: new Date().toISOString() }
      });

      res.json({ success: true, messageId });
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({ success: false, error: "Failed to send message" });
    }
  });

  app.post("/api/assign", (req, res) => {
    const { contactId, agentId } = req.body;
    db.prepare("UPDATE contacts SET assigned_to = ? WHERE id = ?").run(agentId, contactId);
    broadcast({ type: "CONTACT_ASSIGNED", payload: { contactId, agentId } });
    res.json({ success: true });
  });

  app.delete("/api/contacts/:contactId", (req, res) => {
    const { contactId } = req.params;
    try {
      db.prepare("DELETE FROM messages WHERE contact_id = ?").run(contactId);
      db.prepare("DELETE FROM contacts WHERE id = ?").run(contactId);
      broadcast({ type: "CONTACT_DELETED", payload: { contactId } });
      res.json({ success: true });
    } catch (error) {
      console.error("Delete contact error:", error);
      res.status(500).json({ success: false, error: "Failed to delete contact" });
    }
  });

  app.post("/api/logout", async (req, res) => {
    const { sessionId = 'default' } = req.body;
    try {
      const sock = sessions.get(sessionId);
      if (sock) {
        try {
          await sock.logout();
        } catch (e) {
          console.log(`Graceful logout failed for ${sessionId}, forcing end...`);
          sock.end(undefined);
        }
        sessions.delete(sessionId);
      }
      
      // Force delete the auth folder to ensure a fresh start
      const authPath = path.join(__dirname, `auth_info_${sessionId}`);
      if (fs.existsSync(authPath)) {
        console.log("Removing auth folder:", authPath);
        fs.rmSync(authPath, { recursive: true, force: true });
      }
      
      // Reset auth state in memory and notify clients
      sessionQR.set(sessionId, null);
      sessionStatus.set(sessionId, "logged_out");
      db.prepare("UPDATE connections SET status = 'disconnected' WHERE id = ?").run(sessionId);
      
      broadcast({ 
        type: "AUTH_STATE", 
        sessionId,
        payload: { status: 'logged_out', qr: null } 
      });
      
      // Restart the connection process after a short delay
      setTimeout(() => {
        connectToWhatsApp(sessionId);
      }, 2000);

      res.json({ success: true });
    } catch (error) {
      console.error("Logout error:", error);
      res.status(500).json({ success: false, error: "Failed to logout" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    console.log("Creating Vite server...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    console.log("Vite server created.");
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  const PORT = 3000;
  console.log(`Attempting to start server on port ${PORT}...`);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
