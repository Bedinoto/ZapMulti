import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Search, 
  Send, 
  User, 
  MessageSquare, 
  MoreVertical, 
  Phone, 
  Video, 
  Info,
  Check,
  CheckCheck,
  Clock,
  LogOut,
  Settings,
  Users,
  Filter,
  Paperclip,
  Image as ImageIcon
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface Message {
  id: string;
  contact_id: string;
  sender_id?: string;
  sender_name?: string;
  text: string;
  type: 'incoming' | 'outgoing';
  timestamp: string;
  status: string;
}

interface Contact {
  id: string;
  name: string;
  last_message_at: string;
  assigned_to?: string;
  unread_count?: number;
  is_group?: number;
  session_id?: string;
}

interface Agent {
  id: string;
  name: string;
  role: string;
  status: string;
}

interface Connection {
  id: string;
  name: string;
  status: string;
  qr?: string | null;
  created_at: string;
}

export default function App() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState<'waiting' | 'active'>('waiting');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [showAgentsManager, setShowAgentsManager] = useState(false);
  const [showConnectionsManager, setShowConnectionsManager] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('default');
  const [filterSessionId, setFilterSessionId] = useState<string | 'all'>('all');
  const [currentUser] = useState({ id: 'agent_1', name: 'Admin Agent', role: 'admin' });
  
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentRole, setNewAgentRole] = useState('agent');
  const [newConnectionName, setNewConnectionName] = useState('');
  const [isSendingFile, setIsSendingFile] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const ws = useRef<WebSocket | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch initial data
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [contactsRes, agentsRes, connectionsRes] = await Promise.all([
          fetch('/api/contacts'),
          fetch('/api/agents'),
          fetch('/api/connections')
        ]);

        if (contactsRes.ok) setContacts(await contactsRes.json());
        if (agentsRes.ok) setAgents(await agentsRes.json());
        if (connectionsRes.ok) setConnections(await connectionsRes.json());
      } catch (err) {
        console.error('Error fetching initial data:', err);
      }
    };
    
    fetchData();
  }, []);

  // Fetch messages when contact changes
  useEffect(() => {
    if (selectedContact) {
      fetch(`/api/messages/${selectedContact.id}?sessionId=${selectedContact.session_id}`)
        .then(res => res.json())
        .then(data => setMessages(data));
    }
  }, [selectedContact]);

  // WebSocket setup
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}`);
    
    socket.onopen = () => {
      console.log('WebSocket connected');
    };

    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'AUTH_STATE') {
        const { sessionId, payload } = data;
        setConnections(prev => prev.map(conn => 
          conn.id === (sessionId || 'default') 
            ? { ...conn, status: payload.status, qr: payload.qr } 
            : conn
        ));
      }

      if (data.type === 'NEW_MESSAGE') {
        const newMsg = data.payload;
        const sessionId = data.sessionId;
        
        // Update messages if it's the current conversation
        if (selectedContact && newMsg.contact_id === selectedContact.id && sessionId === selectedContact.session_id) {
          setMessages(prev => [...prev, newMsg]);
        }

        // Update contacts list
        setContacts(prev => {
          const existing = prev.find(c => c.id === newMsg.contact_id && c.session_id === sessionId);
          const isCurrentContact = selectedContact && newMsg.contact_id === selectedContact.id && sessionId === selectedContact.session_id;
          
          if (existing) {
            return [
              { 
                ...existing, 
                last_message_at: newMsg.timestamp, 
                unread_count: isCurrentContact ? 0 : (existing.unread_count || 0) + (newMsg.type === 'incoming' ? 1 : 0)
              },
              ...prev.filter(c => !(c.id === newMsg.contact_id && c.session_id === sessionId))
            ];
          } else {
            return [
              { 
                id: newMsg.contact_id, 
                name: newMsg.contact_name || newMsg.contact_id, 
                last_message_at: newMsg.timestamp,
                session_id: sessionId,
                unread_count: isCurrentContact ? 0 : (newMsg.type === 'incoming' ? 1 : 0)
              },
              ...prev
            ];
          }
        });
      }

      if (data.type === 'CONTACT_ASSIGNED') {
        const { contactId, agentId, sessionId } = data.payload;
        setContacts(prev => prev.map(c => (c.id === contactId && c.session_id === sessionId) ? { ...c, assigned_to: agentId } : c));
        if (selectedContact?.id === contactId && selectedContact?.session_id === sessionId) {
          setSelectedContact(prev => prev ? { ...prev, assigned_to: agentId } : null);
        }
      }

      if (data.type === 'CONTACT_DELETED') {
        const { contactId, sessionId } = data.payload;
        setContacts(prev => prev.filter(c => !(c.id === contactId && c.session_id === sessionId)));
        if (selectedContact?.id === contactId && selectedContact?.session_id === sessionId) {
          setSelectedContact(null);
          setMessages([]);
        }
      }

      if (data.type === 'AGENT_CREATED') {
        setAgents(prev => [...prev, data.payload]);
      }

      if (data.type === 'AGENT_DELETED') {
        const { id } = data.payload;
        setAgents(prev => prev.filter(a => a.id !== id));
        setContacts(prev => prev.map(c => c.assigned_to === id ? { ...c, assigned_to: undefined } : c));
      }
    };

    ws.current = socket;
    return () => socket.close();
  }, [selectedContact]);

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !selectedContact) return;

    const text = inputText;
    setInputText('');

    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          contactId: selectedContact.id, 
          text, 
          sessionId: selectedContact.session_id || selectedSessionId 
        })
      });
      const data = await res.json();
      if (!data.success) {
        console.error('Failed to send:', data.error);
      }
    } catch (err) {
      console.error('Error sending message:', err);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedContact) return;

    setIsSendingFile(true);

    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64Data = (reader.result as string).split(',')[1];
        
        const res = await fetch('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            contactId: selectedContact.id, 
            media: {
              data: base64Data,
              mimeType: file.type,
              fileName: file.name
            },
            sessionId: selectedContact.session_id || selectedSessionId 
          })
        });
        
        const data = await res.json();
        if (!data.success) {
          console.error('Failed to send file:', data.error);
          alert('Erro ao enviar arquivo: ' + (data.error || 'Erro desconhecido'));
        }
        
        setIsSendingFile(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error('Error sending file:', err);
      setIsSendingFile(false);
      alert('Erro ao processar arquivo');
    }
  };

  const filteredContacts = useMemo(() => {
    let filtered = contacts.filter(c => 
      c.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
      c.id.includes(searchTerm)
    );

    if (filterSessionId !== 'all') {
      filtered = filtered.filter(c => c.session_id === filterSessionId);
    }

    if (activeTab === 'waiting') {
      return filtered.filter(c => !c.assigned_to);
    } else {
      return filtered.filter(c => !!c.assigned_to);
    }
  }, [contacts, searchTerm, activeTab, filterSessionId]);

  const getConnectionColor = (id: string) => {
    const colors = [
      'bg-blue-100 text-blue-700 border-blue-200',
      'bg-purple-100 text-purple-700 border-purple-200',
      'bg-orange-100 text-orange-700 border-orange-200',
      'bg-pink-100 text-pink-700 border-pink-200',
      'bg-indigo-100 text-indigo-700 border-indigo-200',
      'bg-cyan-100 text-cyan-700 border-cyan-200',
    ];
    if (id === 'default') return 'bg-emerald-100 text-emerald-700 border-emerald-200';
    // Simple hash for stable color
    const index = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;
    return colors[index];
  };

  const formatTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const handleAccept = async (contactId: string, sessionId: string) => {
    try {
      await fetch('/api/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, agentId: currentUser.id, sessionId })
      });
      setActiveTab('active');
    } catch (err) {
      console.error('Error accepting contact:', err);
    }
  };

  const handleFinish = async (contactId: string, sessionId: string) => {
    if (!confirm('Deseja realmente finalizar este atendimento?')) return;
    try {
      await fetch(`/api/contacts/${contactId}?sessionId=${sessionId}`, {
        method: 'DELETE'
      });
      setSelectedContact(null);
    } catch (err) {
      console.error('Error finishing service:', err);
    }
  };

  const handleReject = async (contactId: string, sessionId: string) => {
    if (!confirm('Tem certeza que deseja recusar e excluir este atendimento?')) return;
    try {
      await fetch(`/api/contacts/${contactId}?sessionId=${sessionId}`, {
        method: 'DELETE'
      });
    } catch (err) {
      console.error('Error rejecting contact:', err);
    }
  };

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAgentName.trim()) return;
    try {
      await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newAgentName, role: newAgentRole })
      });
      setNewAgentName('');
    } catch (err) {
      console.error('Error creating agent:', err);
    }
  };

  const handleDeleteAgent = async (id: string) => {
    if (!confirm('Deseja realmente excluir este agente?')) return;
    try {
      await fetch(`/api/agents/${id}`, { method: 'DELETE' });
    } catch (err) {
      console.error('Error deleting agent:', err);
    }
  };

  const handleCreateConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newConnectionName.trim()) return;
    try {
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newConnectionName })
      });
      if (res.ok) {
        const data = await res.json();
        setConnections(prev => [...prev, { 
          id: data.id, 
          name: newConnectionName, 
          status: 'initializing', 
          created_at: new Date().toISOString() 
        }]);
        setNewConnectionName('');
      }
    } catch (err) {
      console.error('Error creating connection:', err);
    }
  };

  const handleDeleteConnection = async (id: string) => {
    if (id === 'default') return alert('A conexão principal não pode ser excluída.');
    if (!confirm('Deseja realmente excluir esta conexão? Todos os dados de autenticação serão removidos.')) return;
    try {
      const res = await fetch(`/api/connections/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setConnections(prev => prev.filter(c => c.id !== id));
        if (selectedSessionId === id) setSelectedSessionId('default');
      }
    } catch (err) {
      console.error('Error deleting connection:', err);
    }
  };

  const handleResetSession = async (sessionId: string) => {
    if (!confirm('Deseja realmente resetar esta sessão? Você precisará escanear o QR Code novamente.')) return;
    try {
      await fetch('/api/logout', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
    } catch (err) {
      console.error('Error resetting session:', err);
    }
  };

  const activeConnection = connections.find(c => c.id === selectedSessionId) || connections[0];

  return (
    <div className="flex h-screen bg-[#F0F2F5] text-[#111B21] font-sans">
      {/* Left Sidebar - Navigation */}
      <div className="w-16 bg-[#F0F2F5] border-r border-[#D1D7DB] flex flex-col items-center py-4 space-y-6">
        <div 
          className="w-10 h-10 bg-[#00A884] rounded-full flex items-center justify-center text-white cursor-pointer" 
          onClick={() => {
            setShowAgentsManager(false);
            setShowConnectionsManager(false);
          }}
        >
          <MessageSquare size={20} />
        </div>
        <div className="flex-1 space-y-4">
          <button 
            onClick={() => {
              setShowAgentsManager(true);
              setShowConnectionsManager(false);
            }}
            className={`p-2 rounded-lg transition-colors ${showAgentsManager ? 'bg-[#D1D7DB] text-[#00A884]' : 'text-[#54656F] hover:bg-[#D1D7DB]'}`}
            title="Gestão de Agentes"
          >
            <Users size={24} />
          </button>
          <button 
            onClick={() => {
              setShowConnectionsManager(true);
              setShowAgentsManager(false);
            }}
            className={`p-2 rounded-lg transition-colors ${showConnectionsManager ? 'bg-[#D1D7DB] text-[#00A884]' : 'text-[#54656F] hover:bg-[#D1D7DB]'}`}
            title="Conexões WhatsApp"
          >
            <Phone size={24} />
          </button>
        </div>
        <div className="space-y-4">
          <button className="p-2 text-[#54656F] hover:bg-[#D1D7DB] rounded-lg transition-colors">
            <Settings size={24} />
          </button>
          <div className="w-10 h-10 bg-[#D1D7DB] rounded-full flex items-center justify-center text-[#54656F]">
            <User size={20} />
          </div>
        </div>
      </div>

      {/* Contacts List */}
      <div className="w-96 bg-white border-r border-[#D1D7DB] flex flex-col">
        <div className="p-4 bg-[#F0F2F5] flex justify-between items-center">
          <h1 className="text-xl font-bold">Conversas</h1>
          <div className="flex space-x-2">
            <button className="p-2 text-[#54656F] hover:bg-[#D1D7DB] rounded-full">
              <MoreVertical size={20} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[#D1D7DB] bg-white">
          <button 
            onClick={() => setActiveTab('waiting')}
            className={`flex-1 py-3 text-sm font-medium transition-colors relative ${
              activeTab === 'waiting' ? 'text-[#00A884]' : 'text-[#667781] hover:bg-[#F5F6F6]'
            }`}
          >
            Aguardando
            {activeTab === 'waiting' && (
              <motion.div layoutId="activeTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#00A884]" />
            )}
            {contacts.filter(c => !c.assigned_to).length > 0 && (
              <span className="ml-2 bg-[#25D366] text-white text-[10px] px-1.5 py-0.5 rounded-full">
                {contacts.filter(c => !c.assigned_to).length}
              </span>
            )}
          </button>
          <button 
            onClick={() => setActiveTab('active')}
            className={`flex-1 py-3 text-sm font-medium transition-colors relative ${
              activeTab === 'active' ? 'text-[#00A884]' : 'text-[#667781] hover:bg-[#F5F6F6]'
            }`}
          >
            Atendimento
            {activeTab === 'active' && (
              <motion.div layoutId="activeTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#00A884]" />
            )}
          </button>
        </div>

        <div className="p-2 space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 text-[#54656F]" size={18} />
            <input
              type="text"
              placeholder="Pesquisar conversas..."
              className="w-full bg-[#F0F2F5] rounded-lg py-2 pl-10 pr-4 text-sm focus:outline-none"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          {/* Connection Filter Chips */}
          {connections.length > 1 && (
            <div className="flex overflow-x-auto pb-1 space-x-2 no-scrollbar">
              <button
                onClick={() => setFilterSessionId('all')}
                className={`flex-shrink-0 px-3 py-1 rounded-full text-[10px] font-bold border transition-all ${
                  filterSessionId === 'all' 
                    ? 'bg-[#00A884] text-white border-[#00A884]' 
                    : 'bg-white text-[#667781] border-[#D1D7DB] hover:bg-[#F5F6F6]'
                }`}
              >
                TODAS
              </button>
              {connections.map(conn => (
                <button
                  key={conn.id}
                  onClick={() => setFilterSessionId(conn.id)}
                  className={`flex-shrink-0 px-3 py-1 rounded-full text-[10px] font-bold border transition-all truncate max-w-[120px] ${
                    filterSessionId === conn.id 
                      ? 'bg-[#00A884] text-white border-[#00A884]' 
                      : 'bg-white text-[#667781] border-[#D1D7DB] hover:bg-[#F5F6F6]'
                  }`}
                >
                  {conn.name.toUpperCase()}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {filteredContacts.map(contact => (
            <div
              key={`${contact.id}-${contact.session_id}`}
              className={`w-full flex flex-col border-b border-[#F0F2F5] transition-colors ${selectedContact?.id === contact.id && selectedContact?.session_id === contact.session_id ? 'bg-[#F0F2F5]' : 'hover:bg-[#F5F6F6]'}`}
            >
              <button
                onClick={() => {
                  setSelectedContact(contact);
                  setContacts(prev => prev.map(c => (c.id === contact.id && c.session_id === contact.session_id) ? { ...c, unread_count: 0 } : c));
                }}
                className="w-full flex items-center p-3 text-left"
              >
                <div className="w-12 h-12 bg-[#D1D7DB] rounded-full flex items-center justify-center text-[#54656F] mr-3 overflow-hidden">
                  {contact.is_group ? (
                    <Users size={24} />
                  ) : (
                    <User size={24} />
                  )}
                </div>
                <div className="flex-1 text-left">
                  <div className="flex justify-between items-center">
                    <div className="flex flex-col">
                      <span className="font-medium truncate flex items-center">
                        {contact.name}
                        {contact.is_group === 1 && (
                          <span className="ml-1 text-[10px] bg-[#D1D7DB] px-1 rounded uppercase">Grupo</span>
                        )}
                      </span>
                      {contact.session_id && (
                        <div className={`mt-0.5 px-1.5 py-0.5 rounded border text-[8px] font-bold uppercase w-fit leading-none ${getConnectionColor(contact.session_id)}`}>
                          {connections.find(conn => conn.id === contact.session_id)?.name || 'Conexão'}
                        </div>
                      )}
                    </div>
                    <span className="text-xs text-[#667781]">{formatTime(contact.last_message_at)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <p className="text-sm text-[#667781] truncate">
                      {contact.assigned_to ? `Atribuído a: ${contact.assigned_to}` : 'Aguardando atendimento'}
                    </p>
                    {contact.unread_count ? (
                      <span className="bg-[#25D366] text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                        {contact.unread_count}
                      </span>
                    ) : null}
                  </div>
                </div>
              </button>
              
              {activeTab === 'waiting' && (
                <div className="flex px-3 pb-3 space-x-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAccept(contact.id, contact.session_id!);
                    }}
                    className="flex-1 bg-[#00A884] text-white text-xs font-bold py-1.5 rounded hover:bg-[#008F70] transition-colors flex items-center justify-center"
                  >
                    <Check size={14} className="mr-1" /> Aceitar
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReject(contact.id, contact.session_id!);
                    }}
                    className="flex-1 bg-white text-red-500 border border-red-500 text-xs font-bold py-1.5 rounded hover:bg-red-50 transition-colors flex items-center justify-center"
                  >
                    <LogOut size={14} className="mr-1 rotate-180" /> Recusar
                  </button>
                </div>
              )}

              {activeTab === 'active' && (
                <div className="flex px-3 pb-3 space-x-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleFinish(contact.id, contact.session_id!);
                    }}
                    className="flex-1 bg-[#00A884] text-white text-xs font-bold py-1.5 rounded hover:bg-[#008F70] transition-colors flex items-center justify-center"
                  >
                    <CheckCheck size={14} className="mr-1" /> Finalizar
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col bg-[#EFEAE2] relative">
        {/* Agents Manager Overlay */}
        {showAgentsManager && (
          <div className="absolute inset-0 z-40 bg-[#F0F2F5] flex flex-col">
            <div className="h-16 bg-[#F0F2F5] border-b border-[#D1D7DB] flex items-center px-6 justify-between">
              <div className="flex items-center">
                <button onClick={() => setShowAgentsManager(false)} className="mr-4 text-[#54656F] hover:text-[#111B21]">
                  <LogOut size={24} className="rotate-180" />
                </button>
                <h2 className="text-xl font-bold">Gestão de Agentes</h2>
              </div>
            </div>

            <div className="flex-1 flex overflow-hidden">
              {/* Add Agent Form */}
              <div className="w-80 p-6 border-r border-[#D1D7DB] bg-white">
                <h3 className="text-lg font-medium mb-4">Novo Agente</h3>
                <form onSubmit={handleCreateAgent} className="space-y-4">
                  <div>
                    <label className="block text-sm text-[#667781] mb-1">Nome</label>
                    <input 
                      type="text" 
                      className="w-full p-2 bg-[#F0F2F5] rounded border-none focus:ring-1 focus:ring-[#00A884]"
                      value={newAgentName}
                      onChange={(e) => setNewAgentName(e.target.value)}
                      placeholder="Ex: Suporte João"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-[#667781] mb-1">Função</label>
                    <select 
                      className="w-full p-2 bg-[#F0F2F5] rounded border-none focus:ring-1 focus:ring-[#00A884]"
                      value={newAgentRole}
                      onChange={(e) => setNewAgentRole(e.target.value)}
                    >
                      <option value="agent">Agente</option>
                      <option value="admin">Administrador</option>
                    </select>
                  </div>
                  <button 
                    type="submit"
                    className="w-full bg-[#00A884] text-white py-2 rounded font-medium hover:bg-[#008F70] transition-colors"
                  >
                    Adicionar Agente
                  </button>
                </form>
              </div>

              {/* Agents List */}
              <div className="flex-1 p-6 overflow-y-auto">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {agents.map(agent => (
                    <div key={agent.id} className="bg-white p-4 rounded-xl shadow-sm border border-[#D1D7DB] flex items-center justify-between">
                      <div className="flex items-center">
                        <div className="w-12 h-12 bg-[#D1D7DB] rounded-full flex items-center justify-center text-[#54656F] mr-4">
                          <User size={24} />
                        </div>
                        <div>
                          <h4 className="font-medium">{agent.name}</h4>
                          <p className="text-xs text-[#667781] uppercase tracking-wider">{agent.role}</p>
                        </div>
                      </div>
                      {agent.id !== 'agent_1' && (
                        <button 
                          onClick={() => handleDeleteAgent(agent.id)}
                          className="p-2 text-red-500 hover:bg-red-50 rounded-full transition-colors"
                        >
                          <LogOut size={18} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Connections Manager Overlay */}
        {showConnectionsManager && (
          <div className="absolute inset-0 z-40 bg-[#F0F2F5] flex flex-col">
            <div className="h-16 bg-[#F0F2F5] border-b border-[#D1D7DB] flex items-center px-6 justify-between">
              <div className="flex items-center">
                <button onClick={() => setShowConnectionsManager(false)} className="mr-4 text-[#54656F] hover:text-[#111B21]">
                  <LogOut size={24} className="rotate-180" />
                </button>
                <h2 className="text-xl font-bold">Conexões WhatsApp</h2>
              </div>
            </div>

            <div className="flex-1 flex overflow-hidden">
              {/* Add Connection Form */}
              <div className="w-80 p-6 border-r border-[#D1D7DB] bg-white">
                <h3 className="text-lg font-medium mb-4">Nova Conexão</h3>
                <form onSubmit={handleCreateConnection} className="space-y-4">
                  <div>
                    <label className="block text-sm text-[#667781] mb-1">Nome da Conexão</label>
                    <input 
                      type="text" 
                      className="w-full p-2 bg-[#F0F2F5] rounded border-none focus:ring-1 focus:ring-[#00A884]"
                      value={newConnectionName}
                      onChange={(e) => setNewConnectionName(e.target.value)}
                      placeholder="Ex: Celular Vendas"
                    />
                  </div>
                  <button 
                    type="submit"
                    className="w-full bg-[#00A884] text-white py-2 rounded font-medium hover:bg-[#008F70] transition-colors"
                  >
                    Adicionar Conexão
                  </button>
                </form>
                
                <div className="mt-8 p-4 bg-blue-50 rounded-lg border border-blue-100">
                  <h4 className="text-sm font-bold text-blue-800 mb-2">Dica</h4>
                  <p className="text-xs text-blue-700 leading-relaxed">
                    Você pode conectar múltiplos números de WhatsApp. Cada conexão gera seu próprio QR Code.
                  </p>
                </div>
              </div>

              {/* Connections List */}
              <div className="flex-1 p-6 overflow-y-auto">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {connections.map(conn => (
                    <div 
                      key={conn.id} 
                      className={`bg-white p-6 rounded-2xl shadow-sm border-2 transition-all ${
                        selectedSessionId === conn.id ? 'border-[#00A884]' : 'border-transparent'
                      }`}
                    >
                      <div className="flex justify-between items-start mb-4">
                        <div>
                          <h4 className="font-bold text-lg">{conn.name}</h4>
                          <div className="flex items-center mt-1">
                            <div className={`w-2 h-2 rounded-full mr-2 ${
                              conn.status === 'connected' ? 'bg-[#25D366]' : 
                              conn.status === 'qr_ready' ? 'bg-yellow-400' : 'bg-red-400'
                            }`} />
                            <span className="text-xs text-[#667781] uppercase font-bold tracking-wider">
                              {conn.status === 'connected' ? 'Conectado' : 
                               conn.status === 'qr_ready' ? 'Aguardando QR' : 
                               conn.status === 'initializing' ? 'Iniciando' : 'Desconectado'}
                            </span>
                          </div>
                        </div>
                        <div className="flex space-x-1">
                          <button 
                            onClick={() => handleResetSession(conn.id)}
                            className="p-2 text-yellow-600 hover:bg-yellow-50 rounded-full transition-colors"
                            title="Resetar Sessão"
                          >
                            <Clock size={18} />
                          </button>
                          {conn.id !== 'default' && (
                            <button 
                              onClick={() => handleDeleteConnection(conn.id)}
                              className="p-2 text-red-500 hover:bg-red-50 rounded-full transition-colors"
                              title="Excluir Conexão"
                            >
                              <LogOut size={18} />
                            </button>
                          )}
                        </div>
                      </div>

                      {conn.status === 'qr_ready' && conn.qr ? (
                        <div className="flex flex-col items-center p-4 bg-[#F0F2F5] rounded-xl mb-4">
                          <img src={conn.qr} alt="QR Code" className="w-40 h-40 mb-2" />
                          <p className="text-[10px] text-[#667781] text-center">Escaneie para conectar</p>
                        </div>
                      ) : conn.status === 'connected' ? (
                        <div className="flex flex-col items-center justify-center h-44 bg-green-50 rounded-xl mb-4 text-green-600">
                          <CheckCheck size={48} className="mb-2" />
                          <p className="text-sm font-bold">Pronto para uso</p>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center h-44 bg-gray-50 rounded-xl mb-4 text-gray-400">
                          <Clock size={48} className="mb-2 animate-pulse" />
                          <p className="text-sm">Aguardando...</p>
                        </div>
                      )}

                      <button 
                        onClick={() => setSelectedSessionId(conn.id)}
                        disabled={conn.status !== 'connected'}
                        className={`w-full py-2 rounded-lg font-bold transition-colors ${
                          selectedSessionId === conn.id 
                            ? 'bg-[#00A884] text-white' 
                            : conn.status === 'connected' 
                              ? 'bg-[#F0F2F5] text-[#00A884] hover:bg-[#D1D7DB]' 
                              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                        }`}
                      >
                        {selectedSessionId === conn.id ? 'Sessão Ativa' : 'Usar esta Conexão'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Connection Overlay */}
        {activeConnection?.status !== 'connected' && (
          <div className="absolute inset-0 z-50 bg-white/90 backdrop-blur-sm flex flex-col items-center justify-center p-8 text-center">
            <div className="max-w-md w-full bg-white p-8 rounded-2xl shadow-2xl border border-[#D1D7DB]">
              <h2 className="text-2xl font-bold mb-2">Conectar {activeConnection?.name || 'WhatsApp'}</h2>
              <p className="text-sm text-[#667781] mb-6">Você precisa estar conectado para enviar e receber mensagens.</p>
              
              {(!activeConnection || activeConnection.status === 'initializing') && (
                <div className="flex flex-col items-center">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#00A884] mb-4"></div>
                  <p className="text-[#667781]">Iniciando conexão...</p>
                </div>
              )}

              {activeConnection?.status === 'qr_ready' && activeConnection.qr && (
                <div className="flex flex-col items-center">
                  <p className="text-[#667781] mb-6">Abra o WhatsApp no seu celular, toque em Aparelhos conectados e escaneie o código abaixo:</p>
                  <div className="bg-white p-4 rounded-xl border-4 border-[#00A884] mb-6">
                    <img src={activeConnection.qr} alt="WhatsApp QR Code" className="w-64 h-64" />
                  </div>
                  <div className="flex items-center text-sm text-[#00A884] font-medium animate-pulse">
                    <Clock size={16} className="mr-2" /> Aguardando leitura...
                  </div>
                </div>
              )}

              {(activeConnection?.status === 'disconnected' || activeConnection?.status === 'error') && (
                <div className="flex flex-col items-center">
                  <div className="w-16 h-16 bg-red-100 text-red-500 rounded-full flex items-center justify-center mb-4">
                    <LogOut size={32} />
                  </div>
                  <p className="text-[#667781] mb-6">A conexão foi encerrada ou falhou.</p>
                  <div className="flex space-x-4">
                    <button 
                      onClick={() => window.location.reload()}
                      className="bg-[#00A884] text-white px-6 py-2 rounded-lg font-medium hover:bg-[#008F70] transition-colors"
                    >
                      Tentar Novamente
                    </button>
                    <button 
                      onClick={() => handleResetSession(activeConnection.id)}
                      className="bg-white text-red-500 border border-red-500 px-6 py-2 rounded-lg font-medium hover:bg-red-50 transition-colors"
                    >
                      Resetar Sessão
                    </button>
                  </div>
                </div>
              )}

              {activeConnection?.status === 'logged_out' && (
                <div className="flex flex-col items-center">
                  <div className="w-16 h-16 bg-yellow-100 text-yellow-600 rounded-full flex items-center justify-center mb-4">
                    <LogOut size={32} />
                  </div>
                  <p className="text-[#667781] mb-6">Você foi desconectado. Escaneie o QR Code novamente.</p>
                  <button 
                    onClick={() => window.location.reload()}
                    className="bg-[#00A884] text-white px-6 py-2 rounded-lg font-medium hover:bg-[#008F70] transition-colors"
                  >
                    Gerar Novo QR Code
                  </button>
                </div>
              )}
              
              <div className="mt-8 pt-6 border-t border-[#F0F2F5]">
                <button 
                  onClick={() => setShowConnectionsManager(true)}
                  className="text-[#00A884] text-sm font-bold hover:underline"
                >
                  Gerenciar outras conexões
                </button>
              </div>
            </div>
          </div>
        )}

        {selectedContact ? (
          <>
            {/* Chat Header */}
            <div className="h-16 bg-[#F0F2F5] border-b border-[#D1D7DB] flex items-center px-4 justify-between z-10">
              <div className="flex items-center cursor-pointer" onClick={() => setIsSidebarOpen(!isSidebarOpen)}>
                <div className="w-10 h-10 bg-[#D1D7DB] rounded-full flex items-center justify-center text-[#54656F] mr-3">
                  {selectedContact.is_group ? <Users size={20} /> : <User size={20} />}
                </div>
                <div>
                  <div className="flex items-center">
                    <h2 className="font-medium">{selectedContact.name}</h2>
                    {selectedContact.session_id && (
                      <span className={`ml-2 px-1.5 py-0.5 rounded border text-[8px] font-bold uppercase leading-none ${getConnectionColor(selectedContact.session_id)}`}>
                        {connections.find(conn => conn.id === selectedContact.session_id)?.name || 'Conexão'}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[#667781]">
                    {selectedContact.is_group ? 'Grupo' : (selectedContact.assigned_to ? `Atribuído a ${selectedContact.assigned_to}` : 'Clique para informações')}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-4 text-[#54656F]">
                <button className="p-2 hover:bg-[#D1D7DB] rounded-full"><Video size={20} /></button>
                <button className="p-2 hover:bg-[#D1D7DB] rounded-full"><Phone size={20} /></button>
                <button className="p-2 hover:bg-[#D1D7DB] rounded-full"><Search size={20} /></button>
                <button className="p-2 hover:bg-[#D1D7DB] rounded-full"><MoreVertical size={20} /></button>
              </div>
            </div>

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-[url('https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png')] bg-repeat">
              <AnimatePresence initial={false}>
                {messages.map((msg) => (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex ${msg.type === 'outgoing' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[65%] p-2 rounded-lg shadow-sm relative ${
                        msg.type === 'outgoing' ? 'bg-[#D9FDD3] rounded-tr-none' : 'bg-white rounded-tl-none'
                      }`}
                    >
                      {selectedContact.is_group === 1 && msg.type === 'incoming' && (
                        <p className="text-[10px] font-bold text-[#00A884] mb-1">{msg.sender_name}</p>
                      )}
                      <p className="text-sm pr-12">{msg.text}</p>
                      <div className="flex items-center justify-end space-x-1 mt-1">
                        <span className="text-[10px] text-[#667781]">{formatTime(msg.timestamp)}</span>
                        {msg.type === 'outgoing' && (
                          <span className="text-[#53bdeb]">
                            {msg.status === 'read' ? <CheckCheck size={14} /> : <Check size={14} />}
                          </span>
                        )}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="bg-[#F0F2F5] p-3 flex items-center space-x-2">
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileSelect} 
                className="hidden" 
              />
              <button 
                onClick={() => fileInputRef.current?.click()}
                disabled={isSendingFile}
                className={`p-2 text-[#54656F] hover:bg-[#D1D7DB] rounded-full ${isSendingFile ? 'animate-pulse' : ''}`}
                title="Anexar arquivo"
              >
                <Paperclip size={24} />
              </button>
              <form onSubmit={handleSendMessage} className="flex-1 flex items-center space-x-2">
                <input
                  type="text"
                  placeholder="Digite uma mensagem"
                  className="flex-1 bg-white rounded-lg py-2 px-4 focus:outline-none text-sm"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                />
                <button
                  type="submit"
                  disabled={!inputText.trim()}
                  className={`p-2 rounded-full transition-colors ${
                    inputText.trim() ? 'text-[#00A884] hover:bg-[#D1D7DB]' : 'text-[#54656F]'
                  }`}
                >
                  <Send size={24} />
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-[#F0F2F5]">
            <div className="w-64 h-64 mb-8">
              <img 
                src="https://static.whatsapp.net/rsrc.php/v3/y6/r/wa669ae5z22.png" 
                alt="WhatsApp Web" 
                className="w-full h-full object-contain opacity-50"
                referrerPolicy="no-referrer"
              />
            </div>
            <h2 className="text-3xl font-light text-[#41525d] mb-4">ZapMulti Web</h2>
            <p className="text-[#667781] max-w-md">
              Envie e receba mensagens sem precisar manter seu celular conectado.
              Use o ZapMulti em até 4 dispositivos conectados e 1 celular ao mesmo tempo.
            </p>
            <div className="mt-auto text-[#8696a0] flex items-center text-xs">
              <LogOut size={12} className="mr-1" /> Criptografado de ponta a ponta
            </div>
          </div>
        )}

        {/* Right Sidebar - Info */}
        <AnimatePresence>
          {isSidebarOpen && selectedContact && (
            <motion.div
              initial={{ x: 400 }}
              animate={{ x: 0 }}
              exit={{ x: 400 }}
              className="absolute right-0 top-0 bottom-0 w-80 bg-white border-l border-[#D1D7DB] z-20 flex flex-col shadow-xl"
            >
              <div className="h-16 bg-[#F0F2F5] flex items-center px-4 border-b border-[#D1D7DB]">
                <button onClick={() => setIsSidebarOpen(false)} className="p-2 mr-4 text-[#54656F]">
                  <LogOut size={20} className="rotate-180" />
                </button>
                <span className="font-medium">Dados do contato</span>
              </div>
              
              <div className="flex-1 overflow-y-auto">
                <div className="flex flex-col items-center py-8 border-b border-[#F0F2F5]">
                  <div className="w-40 h-40 bg-[#D1D7DB] rounded-full flex items-center justify-center text-[#54656F] mb-4">
                    <User size={80} />
                  </div>
                  <h3 className="text-xl font-medium">{selectedContact.name}</h3>
                  <p className="text-[#667781]">{selectedContact.id}</p>
                </div>

                <div className="p-4 border-b border-[#F0F2F5]">
                  <h4 className="text-sm text-[#00A884] font-medium mb-4">Atendimento</h4>
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs text-[#667781] block mb-1">Responsável</label>
                      <select 
                        className="w-full p-2 bg-[#F0F2F5] rounded border-none text-sm focus:ring-1 focus:ring-[#00A884]"
                        value={selectedContact.assigned_to || ''}
                        onChange={(e) => {
                          fetch('/api/assign', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ contactId: selectedContact.id, agentId: e.target.value })
                          });
                        }}
                      >
                        <option value="">Não atribuído</option>
                        {agents.map(agent => (
                          <option key={agent.id} value={agent.id}>{agent.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div className="p-4">
                  <button className="w-full flex items-center text-red-500 p-2 hover:bg-red-50 rounded transition-colors">
                    <Info size={20} className="mr-3" />
                    <span>Bloquear contato</span>
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
