const express = require('express');
const app = express();

app.use(express.json());

const VERIFY_TOKEN = process.env.WHATSAPP_TOKEN || "affonso2025";
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// Verificação do webhook
app.get('/api/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receber mensagens
app.post('/api/webhook/whatsapp', (req, res) => {
  try {
    const body = req.body;
    console.log('Mensagem recebida:', JSON.stringify(body, null, 2));

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;

      if (messages && messages.length > 0) {
        const msg = messages[0];
        const from = msg.from;
        const text = msg.text?.body || '';
        console.log(`Mensagem de ${from}: ${text}`);
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Erro:', err);
    res.status(200).json({ status: 'ok' });
  }
});

app.get('/', (req, res) => {
  res.send('WhatsApp Webhook ativo!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
