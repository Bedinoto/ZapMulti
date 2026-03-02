import express from "express";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
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
  proto,
  jidNormalizedUser
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizeJid(jid: string): string {
  if (!jid) return jid;
  return jidNormalizedUser(jid);
}

async function startServer() {
  console.log("Starting server script...");
  const db = await open({
    filename: "whatsapp_v2.db",
    driver: sqlite3.Database
  });
  console.log("Database connected.");

  // Initialize Database
  await db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT,
      session_id TEXT,
      name TEXT,
      last_message_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      assigned_to TEXT,
      is_group INTEGER DEFAULT 0,
      unread_count INTEGER DEFAULT 0,
      PRIMARY KEY (id, session_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      session_id TEXT,
      contact_id TEXT,
      sender_id TEXT,
      sender_name TEXT,
      text TEXT,
      type TEXT, -- 'incoming' or 'outgoing'
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT, -- 'sent', 'delivered', 'read'
      PRIMARY KEY (id, session_id),
      FOREIGN KEY(contact_id, session_id) REFERENCES contacts(id, session_id)
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

  // Migration: Normalize existing JIDs and handle schema changes
  try {
    console.log("Checking database schema...");
    // Check if contacts has a composite PK
    const tableInfo = await db.all("PRAGMA table_info(contacts)");
    if (tableInfo.length > 0) {
      const pkCount = tableInfo.filter((c: any) => c.pk > 0).length;
      const hasUnreadCount = tableInfo.some((c: any) => c.name === 'unread_count');
      const hasSessionId = tableInfo.some((c: any) => c.name === 'session_id');

      if (pkCount < 2 || !hasUnreadCount || !hasSessionId) {
        console.log("Migrating database to composite primary keys and new columns...");
        
        // 1. Migrate contacts
        await db.exec("DROP TABLE IF EXISTS contacts_old");
        await db.exec("ALTER TABLE contacts RENAME TO contacts_old");
        await db.exec(`
          CREATE TABLE contacts (
            id TEXT,
            session_id TEXT,
            name TEXT,
            last_message_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            assigned_to TEXT,
            is_group INTEGER DEFAULT 0,
            unread_count INTEGER DEFAULT 0,
            PRIMARY KEY (id, session_id)
          )
        `);
        
        // Build dynamic insert to handle missing columns in old table
        const oldCols = (await db.all("PRAGMA table_info(contacts_old)")).map((c: any) => c.name);
        const selectId = oldCols.includes('id') ? 'id' : 'NULL';
        const selectSessionId = oldCols.includes('session_id') ? 'session_id' : "'default'";
        const selectName = oldCols.includes('name') ? 'name' : 'id';
        const selectLastMsg = oldCols.includes('last_message_at') ? 'last_message_at' : 'CURRENT_TIMESTAMP';
        const selectAssigned = oldCols.includes('assigned_to') ? 'assigned_to' : 'NULL';
        const selectIsGroup = oldCols.includes('is_group') ? 'is_group' : '0';
        const selectUnread = oldCols.includes('unread_count') ? 'unread_count' : '0';

        await db.exec(`
          INSERT OR IGNORE INTO contacts (id, session_id, name, last_message_at, assigned_to, is_group, unread_count)
          SELECT ${selectId}, ${selectSessionId}, ${selectName}, ${selectLastMsg}, ${selectAssigned}, ${selectIsGroup}, ${selectUnread}
          FROM contacts_old
        `);
        await db.exec("DROP TABLE IF EXISTS contacts_old");

        // 2. Migrate messages
        await db.exec("DROP TABLE IF EXISTS messages_old");
        await db.exec("ALTER TABLE messages RENAME TO messages_old");
        await db.exec(`
          CREATE TABLE messages (
            id TEXT,
            session_id TEXT,
            contact_id TEXT,
            sender_id TEXT,
            sender_name TEXT,
            text TEXT,
            type TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            status TEXT,
            PRIMARY KEY (id, session_id),
            FOREIGN KEY(contact_id, session_id) REFERENCES contacts(id, session_id)
          )
        `);
        
        const oldMsgCols = (await db.all("PRAGMA table_info(messages_old)")).map((c: any) => c.name);
        const mId = oldMsgCols.includes('id') ? 'id' : 'NULL';
        const mSession = oldMsgCols.includes('session_id') ? 'session_id' : "'default'";
        const mContact = oldMsgCols.includes('contact_id') ? 'contact_id' : 'NULL';
        const mSender = oldMsgCols.includes('sender_id') ? 'sender_id' : 'contact_id';
        const mSenderName = oldMsgCols.includes('sender_name') ? 'sender_name' : 'sender_id';
        const mText = oldMsgCols.includes('text') ? 'text' : "''";
        const mType = oldMsgCols.includes('type') ? 'type' : "'incoming'";
        const mTime = oldMsgCols.includes('timestamp') ? 'timestamp' : 'CURRENT_TIMESTAMP';
        const mStatus = oldMsgCols.includes('status') ? 'status' : "'received'";

        await db.exec(`
          INSERT OR IGNORE INTO messages (id, session_id, contact_id, sender_id, sender_name, text, type, timestamp, status)
          SELECT ${mId}, ${mSession}, ${mContact}, ${mSender}, ${mSenderName}, ${mText}, ${mType}, ${mTime}, ${mStatus}
          FROM messages_old
        `);
        await db.exec("DROP TABLE IF EXISTS messages_old");
        console.log("Database migration completed successfully.");
      }
    }
  } catch (e) {
    console.error("Migration error (continuing anyway):", e);
  }

  // Normalize all existing JIDs in the new schema
  const allContacts = await db.all("SELECT id, session_id FROM contacts");
  for (const contact of allContacts as any[]) {
    const normalized = normalizeJid(contact.id);
    if (normalized !== contact.id) {
      try {
        await db.run("UPDATE OR IGNORE contacts SET id = ? WHERE id = ? AND session_id = ?", normalized, contact.id, contact.session_id);
        await db.run("UPDATE messages SET contact_id = ? WHERE contact_id = ? AND session_id = ?", normalized, contact.id, contact.session_id);
        await db.run("DELETE FROM contacts WHERE id = ? AND session_id = ?", contact.id, contact.session_id);
      } catch (e) {
        console.error("Error normalizing contact during startup:", contact.id, e);
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
            await db.run("UPDATE connections SET status = 'disconnected' WHERE id = ?", sessionId);
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
          await db.run("UPDATE connections SET status = 'connected' WHERE id = ?", sessionId);
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

              await db.run(`
                INSERT INTO contacts (id, session_id, name, last_message_at, is_group, unread_count)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
                ON CONFLICT(id, session_id) DO UPDATE SET 
                  name = CASE WHEN contacts.name = contacts.id THEN excluded.name ELSE contacts.name END,
                  last_message_at = CURRENT_TIMESTAMP,
                  unread_count = unread_count + excluded.unread_count
              `, sender, sessionId, name, isGroup ? 1 : 0, unreadIncrement);

              const msgId = msg.key.id;
              await db.run(`
                INSERT OR IGNORE INTO messages (id, session_id, contact_id, sender_id, sender_name, text, type, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'received')
              `, msgId, sessionId, sender, sender, name, text, type);

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
  const existingConnections = await db.all("SELECT id FROM connections");
  if (existingConnections.length === 0) {
    await db.run("INSERT INTO connections (id, name, status) VALUES ('default', 'Conexão Principal', 'disconnected')");
    connectToWhatsApp('default');
  } else {
    existingConnections.forEach((conn: any) => {
      connectToWhatsApp(conn.id);
    });
  }

  // API Endpoints
  app.get("/api/contacts", async (req, res) => {
    const contacts = await db.all("SELECT * FROM contacts ORDER BY last_message_at DESC");
    res.json(contacts);
  });

  app.get("/api/agents", async (req, res) => {
    const agents = await db.all("SELECT * FROM agents");
    res.json(agents);
  });

  app.post("/api/agents", async (req, res) => {
    const { name, role } = req.body;
    const id = "agent_" + Date.now();
    try {
      await db.run("INSERT INTO agents (id, name, role, status) VALUES (?, ?, ?, 'offline')", id, name, role);
      const newAgent = { id, name, role, status: 'offline' };
      broadcast({ type: "AGENT_CREATED", payload: newAgent });
      res.json(newAgent);
    } catch (error) {
      res.status(500).json({ error: "Failed to create agent" });
    }
  });

  app.delete("/api/agents/:id", async (req, res) => {
    const { id } = req.params;
    if (id === 'agent_1') return res.status(400).json({ error: "Cannot delete default admin" });
    try {
      await db.run("DELETE FROM agents WHERE id = ?", id);
      // Unassign contacts
      await db.run("UPDATE contacts SET assigned_to = NULL WHERE assigned_to = ?", id);
      broadcast({ type: "AGENT_DELETED", payload: { id } });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete agent" });
    }
  });

  app.get("/api/messages/:contactId", async (req, res) => {
    const { contactId } = req.params;
    const { sessionId } = req.query;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }
    await db.run("UPDATE contacts SET unread_count = 0 WHERE id = ? AND session_id = ?", contactId, sessionId);
    const messages = await db.all("SELECT * FROM messages WHERE contact_id = ? AND session_id = ? ORDER BY timestamp ASC", contactId, sessionId);
    res.json(messages);
  });

  app.get("/api/connections", async (req, res) => {
    const connections = await db.all("SELECT * FROM connections");
    const enriched = connections.map((conn: any) => ({
      ...conn,
      status: sessionStatus.get(conn.id) || conn.status,
      qr: sessionQR.get(conn.id) || null
    }));
    res.json(enriched);
  });

  app.post("/api/connections", async (req, res) => {
    const { name } = req.body;
    const id = `conn_${Date.now()}`;
    await db.run("INSERT INTO connections (id, name, status) VALUES (?, ?, 'disconnected')", id, name);
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
      
      await db.run("DELETE FROM connections WHERE id = ?", id);
      sessionStatus.delete(id);
      sessionQR.delete(id);
      
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false });
    }
  });

  app.post("/api/send", async (req, res) => {
    const { contactId: rawContactId, text, media, sessionId = 'default' } = req.body;
    const contactId = normalizeJid(rawContactId);
    
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

      await db.run(`
        INSERT INTO messages (id, session_id, contact_id, sender_id, sender_name, text, type, status)
        VALUES (?, ?, ?, 'me', 'Me', ?, 'outgoing', 'sent')
      `, messageId, sessionId, contactId, messageText);

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

  app.post("/api/assign", async (req, res) => {
    const { contactId, agentId, sessionId } = req.body;
    await db.run("UPDATE contacts SET assigned_to = ? WHERE id = ? AND session_id = ?", agentId, contactId, sessionId);
    broadcast({ type: "CONTACT_ASSIGNED", payload: { contactId, agentId, sessionId } });
    res.json({ success: true });
  });

  app.delete("/api/contacts/:contactId", async (req, res) => {
    const { contactId } = req.params;
    const { sessionId } = req.query;
    try {
      await db.run("DELETE FROM messages WHERE contact_id = ? AND session_id = ?", contactId, sessionId);
      await db.run("DELETE FROM contacts WHERE id = ? AND session_id = ?", contactId, sessionId);
      broadcast({ type: "CONTACT_DELETED", payload: { contactId, sessionId } });
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
      await db.run("UPDATE connections SET status = 'disconnected' WHERE id = ?", sessionId);
      
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
