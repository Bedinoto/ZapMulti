import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

async function dump() {
  const db = await open({
    filename: 'whatsapp_v2.db',
    driver: sqlite3.Database
  });
  
  const messagesCount = await db.get("SELECT count(*) as count FROM messages");
  const contactsCount = await db.get("SELECT count(*) as count FROM contacts");
  console.log(`Contacts: ${contactsCount.count}, Messages: ${messagesCount.count}`);
  
  const messages = await db.all("SELECT * FROM messages ORDER BY timestamp DESC LIMIT 10");
  console.log(JSON.stringify(messages, null, 2));
  
  const contacts = await db.all("SELECT * FROM contacts ORDER BY last_message_at DESC LIMIT 10");
  console.log(JSON.stringify(contacts, null, 2));
}

dump().catch(console.error);
