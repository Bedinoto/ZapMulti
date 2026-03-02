# ZapMulti - WhatsApp Multi-Agent Platform

Este projeto é uma plataforma multi-agente para gerenciar conversas do WhatsApp Business com atualizações em tempo real e recursos de atribuição.

## Requisitos

- Node.js >= 20.0.0
- npm

## Instalação

1. Clone o repositório.
2. Instale as dependências:
   ```bash
   npm install
   ```
3. Crie um arquivo `.env` na raiz do projeto com base no `.env.example`:
   ```env
   PORT=3000
   GEMINI_API_KEY="AIzaSyAx6u_3pD1ZjVBBbePD0lvtFDdeF4XmW_M"
   ```

## Desenvolvimento

Para iniciar o servidor de desenvolvimento:
```bash
npm run dev
```

## Produção

Para preparar e iniciar em produção:
```bash
npm run build
npm start
```

## Estrutura de Dados

- O banco de dados SQLite é salvo como `whatsapp_v2.db`.
- As sessões do WhatsApp são salvas em pastas `auth_info_{sessionId}`.

## Deploy no Hostinger / VPS

1. Certifique-se de que o Node.js 20+ está instalado.
2. Faça o upload dos arquivos.
3. Execute `npm install`.
4. O script `postinstall` criará a pasta `dist` automaticamente.
5. Use um gerenciador de processos como o `pm2` para manter o app rodando:
   ```bash
   pm2 start npm --name "zapmulti" -- start
   ```
