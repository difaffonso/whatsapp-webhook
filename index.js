const express = require('express');
const app = express();

app.use(express.json());

const VERIFY_TOKEN = process.env.WHATSAPP_TOKEN || "affonso2025";
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_SECRETARIA = "5511987669852";

// Anti-spam em memória
const ultimoEnvio = {};

function dentroDoHorario() {
  const agora = new Date();
  const sp = new Date(agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const dia = sp.getDay();
  const horaDecimal = sp.getHours() + sp.getMinutes() / 60;
  if (dia >= 1 && dia <= 5) return horaDecimal >= 8 && horaDecimal < 19.5;
  if (dia === 6) return horaDecimal >= 8 && horaDecimal < 12;
  return false;
}

async function enviarMensagem(para, texto) {
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: para,
        type: "text",
        text: { body: texto }
      })
    });
    const data = await response.json();
    console.log("Enviado:", JSON.stringify(data));
  } catch (err) {
    console.error("Erro ao enviar:", err);
  }
}

function linkWhatsApp(texto) {
  return `https://wa.me/${WHATSAPP_SECRETARIA}?text=${encodeURIComponent(texto)}`;
}

function horarioAtendimento() {
  return `🗓 *Horário de atendimento:*\nSegunda a sexta: 8h às 19h30\nSábado: 8h às 12h`;
}

function menuPrincipal() {
  return `Olá! Bem-vindo à *Affonso Odontologia* 🦷\n\nComo posso ajudar você hoje?\n\n1️⃣ Marcar avaliação\n2️⃣ Remarcar consulta\n3️⃣ Urgência\n4️⃣ Falar com atendente\n5️⃣ Outros\n\n_Digite o número da opção desejada._`;
}

function respostaOpcao(opcao) {
  const horario = horarioAtendimento();
  const opcoes = {
    "1": `Para *marcar uma avaliação*, clique no link abaixo! 😊\n\n${horario}\n\n👉 ${linkWhatsApp("Olá! Gostaria de marcar uma avaliação na Affonso Odontologia.")}`,
    "2": `Para *remarcar sua consulta*, clique no link abaixo! 😊\n\n${horario}\n\n👉 ${linkWhatsApp("Olá! Gostaria de remarcar minha consulta na Affonso Odontologia.")}`,
    "3": `Para *urgências odontológicas*, entre em contato com nossa equipe!\n\n${horario}\n\n👉 ${linkWhatsApp("Olá! Estou com uma urgência odontológica e preciso de atendimento.")}`,
    "4": `Para *falar com nossa atendente*, clique no link abaixo! 😊\n\n${horario}\n\n👉 ${linkWhatsApp("Olá! Gostaria de falar com a equipe da Affonso Odontologia.")}`,
    "5": `Para *outros assuntos*, clique no link abaixo! 😊\n\n${horario}\n\n👉 ${linkWhatsApp("Olá! Vim pelo WhatsApp da Affonso Odontologia e preciso de ajuda.")}`
  };
  return opcoes[opcao] || null;
}

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
app.post('/api/webhook/whatsapp', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      // Ignora notificações de status
      if (value?.statuses) {
        console.log('Status ignorado');
        return res.status(200).json({ status: 'ok' });
      }

      const messages = value?.messages;
      if (messages && messages.length > 0) {
        const msg = messages[0];
        const from = msg.from;
        const tipo = msg.type;

        // Respostas de botão (quick_reply dos templates) → redireciona para secretaria
        if (tipo === 'button') {
          const textoBtn = msg.button?.text || 'agendar';
          console.log(`Botão clicado por ${from}: ${textoBtn}`);
          const msgTimestampBtn = parseInt(msg.timestamp) * 1000;
          if (Date.now() - msgTimestampBtn > 30000) {
            console.log(`Botão antigo ignorado de ${from}`);
            return res.status(200).json({ status: 'ok' });
          }
          await enviarMensagem(from,
            `Ótimo! 😊 Vou te conectar com nossa equipe agora.\n\n👉 Clique para conversar diretamente:\nhttps://wa.me/${WHATSAPP_SECRETARIA}?text=${encodeURIComponent('Olá! Vim pelo WhatsApp da Affonso Odontologia e gostaria de ' + textoBtn.toLowerCase() + '.')}`
          );
          return res.status(200).json({ status: 'ok' });
        }

        // Ignora mensagens que não são texto
        if (tipo !== 'text') {
          console.log(`Tipo ${tipo} ignorado`);
          return res.status(200).json({ status: 'ok' });
        }

        // ✅ SOLUÇÃO PRINCIPAL: ignora mensagens com mais de 30 segundos
        // Isso evita reenvios quando o servidor reinicia
        const msgTimestamp = parseInt(msg.timestamp) * 1000;
        const agora = Date.now();
        const idadeMsg = agora - msgTimestamp;
        
        if (idadeMsg > 30000) {
          console.log(`Mensagem antiga ignorada (${Math.round(idadeMsg/1000)}s atrás) de ${from}`);
          return res.status(200).json({ status: 'ok' });
        }

        const texto = msg.text?.body?.trim() || '';
        console.log(`Mensagem de ${from}: ${texto} (${Math.round(idadeMsg/1000)}s atrás)`);

        const opcaoMenu = ['1','2','3','4','5'].includes(texto);

        // Anti-spam adicional: 3 minutos entre menus (para o mesmo número)
        if (!opcaoMenu) {
          const ultimoTempo = ultimoEnvio[from] || 0;
          if (agora - ultimoTempo < 3 * 60 * 1000) {
            console.log(`Anti-spam: ignorando ${from}`);
            return res.status(200).json({ status: 'ok' });
          }
          ultimoEnvio[from] = agora;
        }

        if (!dentroDoHorario()) {
          await enviarMensagem(from,
            `Olá! 😊 Obrigado por entrar em contato com a *Affonso Odontologia* 🦷\n\nNo momento estamos fora do horário de atendimento.\n\n${horarioAtendimento()}\n\nAssim que retornarmos, entraremos em contato. Ou se preferir:\n\n👉 ${linkWhatsApp("Olá! Entrei em contato fora do horário pela Affonso Odontologia.")}`
          );
        } else if (opcaoMenu) {
          await enviarMensagem(from, respostaOpcao(texto));
        } else {
          await enviarMensagem(from, menuPrincipal());
        }
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
