const express = require('express');
const app = express();

app.use(express.json());

const VERIFY_TOKEN = process.env.WHATSAPP_TOKEN || "affonso2025";
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_SECRETARIA = "5511987669852";
const DISPARO_KEY = process.env.DISPARO_KEY || VERIFY_TOKEN;

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

// ============================================================
// Disparo de templates (usado pelo sistema da clínica)
// Tenta vários idiomas: pt_BR -> pt_PT -> en_US -> en
// ============================================================
function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, x-api-key");
}

async function enviarTemplate(to, template, params) {
  const idiomas = ['pt_BR', 'pt_PT', 'en_US', 'en'];
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
  const base = Array.isArray(params) ? params : [];
  // variações de quantidade de parâmetros (caso o template tenha menos campos)
  const variantes = [base];
  if (base.length >= 3) variantes.push([base[0], base[base.length - 1]]);
  if (base.length >= 2) variantes.push([base[0]]);
  let ultimoErro = null;
  for (const lang of idiomas) {
    let proximoIdioma = false;
    for (const ps of variantes) {
      const payload = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'template',
        template: {
          name: template,
          language: { code: lang }
        }
      };
      if (ps.length > 0) {
        payload.template.components = [{
          type: 'body',
          parameters: ps.map(p => ({ type: 'text', text: String(p) }))
        }];
      }
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
        const data = await r.json();
        if (!data.error) {
          console.log('Template OK:', template, lang, 'params:' + ps.length, to);
          return { ok: true, lang: lang, id: data.messages && data.messages[0] && data.messages[0].id };
        }
        ultimoErro = data.error;
        console.log('Template falhou:', template, lang, 'params:' + ps.length, data.error.code, data.error.message);
        if (data.error.code === 132001) { proximoIdioma = true; break; }
        if (data.error.code === 132000) continue; // qtde de parâmetros errada -> tenta próxima variação
        return { ok: false, error: fmtErr(data.error) };
      } catch (err) {
        return { ok: false, error: 'erro de conexão com a Meta' };
      }
    }
    if (!proximoIdioma) break;
  }
  return { ok: false, error: ultimoErro ? fmtErr(ultimoErro) : 'erro desconhecido' };
}

function fmtErr(e) {
  if (!e) return 'erro desconhecido';
  let s = '[' + (e.code || '?') + (e.error_subcode ? ('.' + e.error_subcode) : '') + '] ' + (e.message || '');
  if (e.error_data && e.error_data.details) s += ' - ' + e.error_data.details;
  return s;
}

app.options('/api/disparar', (req, res) => {
  setCors(res);
  res.sendStatus(200);
});

app.post('/api/disparar', async (req, res) => {
  setCors(res);
  try {
    const key = req.headers['x-api-key'] || (req.body && req.body.key);
    if (key !== DISPARO_KEY) {
      return res.status(401).json({ ok: false, error: 'não autorizado' });
    }
    const { template, telefone, params } = req.body || {};
    if (!template || !telefone) {
      return res.status(400).json({ ok: false, error: 'template e telefone são obrigatórios' });
    }
    let to = String(telefone).replace(/\D/g, '');
    if (to.length === 11 || to.length === 10) to = '55' + to;

    const resultado = await enviarTemplate(to, template, params);
    if (!resultado.ok) {
      return res.status(500).json({ ok: false, error: resultado.error });
    }
    return res.json({ ok: true, id: resultado.id, lang: resultado.lang });
  } catch (err) {
    console.error('Erro /api/disparar:', err);
    return res.status(500).json({ ok: false, error: 'erro interno' });
  }
});

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
      if (value?.statuses) {
        return res.status(200).json({ status: 'ok' });
      }
      const messages = value?.messages;
      if (messages && messages.length > 0) {
        const msg = messages[0];
        const from = msg.from;
        const tipo = msg.type;
        if (tipo === 'button') {
          const textoBtn = msg.button?.text || 'agendar';
          const msgTimestampBtn = parseInt(msg.timestamp) * 1000;
          if (Date.now() - msgTimestampBtn > 30000) return res.status(200).json({ status: 'ok' });
          await enviarMensagem(from,
            `Ótimo! 😊 Vou te conectar com nossa equipe agora.\n\n👉 Clique para conversar diretamente:\nhttps://wa.me/${WHATSAPP_SECRETARIA}?text=${encodeURIComponent('Olá! Vim pelo WhatsApp da Affonso Odontologia e gostaria de ' + textoBtn.toLowerCase() + '.')}`
          );
          return res.status(200).json({ status: 'ok' });
        }
        if (tipo !== 'text') return res.status(200).json({ status: 'ok' });
        const msgTimestamp = parseInt(msg.timestamp) * 1000;
        const agora = Date.now();
        const idadeMsg = agora - msgTimestamp;
        if (idadeMsg > 30000) return res.status(200).json({ status: 'ok' });
        const texto = msg.text?.body?.trim() || '';
        // ===== SIM / NAO — resposta ao lembrete de consulta =====
        const norm = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const isSim = norm === 's' || norm === 'sim' || norm.startsWith('sim ') || norm.startsWith('sim,') || norm.startsWith('sim!') || norm.includes('confirmo') || norm.includes('confirmado');
        const isNao = norm === 'n' || norm === 'nao' || norm.startsWith('nao ') || norm.startsWith('nao,') || norm.startsWith('nao!') || norm.includes('cancelar') || norm.includes('desmarcar') || norm.includes('nao vou poder') || norm.includes('nao posso');
        if (isSim || isNao) {
          ultimoEnvio[from] = agora;
          const nomePerfil = value?.contacts?.[0]?.profile?.name || '';
          if (isSim) {
            await enviarMensagem(from, '✅ *Presença confirmada!*\n\nObrigado! Esperamos você. 😊\n\n_Affonso Odontologia_ 🦷');
            await enviarMensagem(WHATSAPP_SECRETARIA, '✅ *PACIENTE CONFIRMOU*\n\n👤 ' + (nomePerfil || 'Paciente') + '\n📱 ' + from + '\n\nRespondeu *SIM* ao lembrete de consulta.');
          } else {
            await enviarMensagem(from, 'Tudo bem! 😊\n\nNossa equipe entrará em contato para *remarcar* seu horário.\n\nSe preferir, ligue: 📞 11 2524-9975\n\n_Affonso Odontologia_ 🦷');
            await enviarMensagem(WHATSAPP_SECRETARIA, '❌ *PACIENTE DESMARCOU*\n\n👤 ' + (nomePerfil || 'Paciente') + '\n📱 ' + from + '\n\nRespondeu *NÃO* ao lembrete.\n⚠️ Ligar para remarcar!');
          }
          return res.status(200).json({ status: 'ok' });
        }
        const opcaoMenu = ['1','2','3','4','5'].includes(texto);
        if (!opcaoMenu) {
          const ultimoTempo = ultimoEnvio[from] || 0;
          if (agora - ultimoTempo < 3 * 60 * 1000) return res.status(200).json({ status: 'ok' });
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
