const express = require('express');
const app = express();

app.use(express.json());

const VERIFY_TOKEN = process.env.WHATSAPP_TOKEN || "affonso2025";
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_SECRETARIA = "5511987669852";
const DISPARO_KEY = process.env.DISPARO_KEY || VERIFY_TOKEN;

// ===== Supabase: atualizar status da consulta =====
const SUPA_URL = "https://ncfsepyzrqaljswjiuiv.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jZnNlcHl6cnFhbGpzd2ppdWl2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1MTg1NzYsImV4cCI6MjA5NDA5NDU3Nn0.j_7sctB2bP0zljxPbh3Q4I_MzEksgL8PO5QNdzbaJDM";

// normaliza telefone para comparar (so digitos, com/sem 55)
function soDigitos(s) { return String(s || '').replace(/[^0-9]/g, ''); }
function mesmoTelefone(a, b) {
  var da = soDigitos(a), db = soDigitos(b);
  if (!da || !db) return false;
  // compara os ultimos 8 digitos (ignora DDI/DDD divergentes)
  return da.slice(-8) === db.slice(-8);
}

// Busca paciente(s) na TABELA patients (separada do clinic_data) pelo telefone.
// Retorna { nome, ids:[...] } ou null. Coleta TODOS os ids possiveis (id do registro E id interno,
// sempre como numero) para casar com appts mesmo havendo cadastro duplicado ou tipo diferente (string x numero).
async function buscarPacientePorTelefone(telefone) {
  try {
    var achados = [], nome = '';
    var lastId = 0, step = 1000;
    for (var guard = 0; guard < 500; guard++) {
      var r = await fetch(SUPA_URL + "/rest/v1/patients?select=id,data&order=id.asc&limit=" + step + "&id=gt." + lastId, {
        headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY }
      });
      if (!r.ok) break;
      var rows = await r.json();
      if (!rows || !rows.length) break;
      for (var k = 0; k < rows.length; k++) {
        var pd = rows[k].data;
        if (pd && mesmoTelefone(pd.phone, telefone)) {
          if (rows[k].id != null) achados.push(Number(rows[k].id));
          if (pd.id != null) achados.push(Number(pd.id));
          if (!nome) nome = pd.name || '';
        }
      }
      lastId = rows[rows.length - 1].id;
      if (rows.length < step) break;
    }
    if (!achados.length) return null;
    var ids = achados.filter(function (v, i, a) { return !isNaN(v) && a.indexOf(v) === i; });
    return { nome: nome, ids: ids };
  } catch (e) {
    console.error('buscarPacientePorTelefone erro:', e);
    return null;
  }
}

// Atualiza status da consulta de amanha (ou a mais proxima futura) do paciente
async function atualizarStatusConsulta(telefone, novoStatus) {
  try {
    // 1) achar paciente pelo telefone (tabela patients, separada do clinic_data)
    var pac = await buscarPacientePorTelefone(telefone);
    if (!pac || !pac.ids || !pac.ids.length) return { ok: false, motivo: 'paciente nao encontrado' };
    var idSet = {};
    pac.ids.forEach(function (i) { idSet[Number(i)] = true; });

    // 2) carregar clinic_data (as consultas ficam aqui)
    var r = await fetch(SUPA_URL + "/rest/v1/clinic_data?id=eq.main&select=data", {
      headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY }
    });
    var rows = await r.json();
    if (!rows || !rows[0] || !rows[0].data) return { ok: false, motivo: 'sem dados' };
    var data = rows[0].data;
    var appts = data.appts || [];

    // 2) datas: amanha e hoje (fuso SP)
    var sp = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    var hojeStr = sp.toISOString().split('T')[0];
    var amanhaD = new Date(sp); amanhaD.setDate(sp.getDate() + 1);
    var amanhaStr = amanhaD.toISOString().split('T')[0];

    // 3) achar consulta: prioridade amanha; senao a proxima futura nao finalizada.
    //    Compara patientId com Number() nos dois lados (evita falha string x numero) e aceita qualquer id do paciente.
    var candidatas = appts.filter(function (a) {
      return idSet[Number(a.patientId)] && (a.status === 'pending' || a.status === 'confirmed');
    });
    var alvo = candidatas.find(function (a) { return a.date === amanhaStr; })
      || candidatas.filter(function (a) { return a.date >= hojeStr; }).sort(function (a, b) { return a.date.localeCompare(b.date); })[0];
    if (!alvo) return { ok: false, motivo: 'consulta nao encontrada', nome: pac.nome };

    // 4) aplicar novo status
    var novoAppts = appts.map(function (a) {
      if (a.id !== alvo.id) return a;
      var patch = { status: novoStatus };
      if (novoStatus === 'cancelled') {
        patch.canceladoWA = true;
        patch.canceladoWAts = new Date().toISOString();
        patch.motivoCancel = 'Cancelou pelo WhatsApp';
        patch.noRebook = false;
        patch.waCancelVisto = false;
      }
      if (novoStatus === 'confirmed') {
        patch.confirmadoWA = true;
        patch.confirmadoWAts = new Date().toISOString();
      }
      return Object.assign({}, a, patch);
    });
    var novoData = Object.assign({}, data, { appts: novoAppts });

    // 5) salvar de volta
    var rs = await fetch(SUPA_URL + "/rest/v1/clinic_data?id=eq.main", {
      method: "PATCH",
      headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Content-Type": "application/json", "Prefer": "return=minimal" },
      body: JSON.stringify({ data: novoData, updated_at: new Date().toISOString() })
    });
    if (!rs.ok) return { ok: false, motivo: 'falha ao salvar', nome: pac.nome };
    return { ok: true, nome: pac.nome, date: alvo.date, time: alvo.time, proc: alvo.procedure || '' };
  } catch (e) {
    console.error('atualizarStatusConsulta erro:', e);
    return { ok: false, motivo: 'erro: ' + (e && e.message) };
  }
}


// Processa resposta SIM/NAO — vale para texto digitado E para botao do template
async function processarRespostaConfirmacao(from, textoResp, nomePerfil) {
  const norm = String(textoResp || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (!norm) return false;
  const isSim = norm === '1' || norm === 's' || norm === 'sim' || norm.indexOf('sim') === 0 || norm.indexOf('confirm') >= 0;
  const isNao = norm === '2' || norm === 'n' || norm === 'nao' || norm.indexOf('nao') === 0 || norm.indexOf('desmarc') >= 0 || norm.indexOf('cancel') >= 0 || norm.indexOf('remarc') >= 0;
  if (!isSim && !isNao) return false;
  const novoStatus = isSim ? 'confirmed' : 'cancelled';
  const res = await atualizarStatusConsulta(from, novoStatus);
  // Se NAO existe consulta futura para este numero, nao trata como confirmacao
  // (ex.: paciente novo digitando 1/2 no menu) -> deixa o menu responder
  if (!res || (!res.ok && (res.motivo === 'consulta nao encontrada' || res.motivo === 'paciente nao encontrado'))) {
    return false;
  }
  const nomeFb = (res && res.nome) || nomePerfil || 'Paciente';
  if (isSim) {
    await enviarMensagem(from, '\u2705 *Presenca confirmada!*\n\nObrigado! Esperamos voce. \ud83d\ude0a\n\n_Affonso Odontologia_ \ud83e\uddb7');
    let avisoSim = '\u2705 *PACIENTE CONFIRMOU*\n\n\ud83d\udc64 ' + nomeFb + '\n\ud83d\udcf1 ' + from;
    if (res && res.ok) {
      avisoSim += '\n\ud83d\udcc5 ' + res.date + ' as ' + res.time + (res.proc ? ' \u2014 ' + res.proc : '');
      avisoSim += '\n\n\u2714\ufe0f *Status atualizado para CONFIRMADO no sistema.*';
    } else {
      avisoSim += '\n\nRespondeu *SIM* ao lembrete.\n\u26a0\ufe0f Nao consegui atualizar o sistema automaticamente (' + ((res && res.motivo) || 'verifique') + '). Confirme manualmente.';
    }
    await enviarMensagem(WHATSAPP_SECRETARIA, avisoSim);
  } else {
    await enviarMensagem(from, 'Tudo bem! \ud83d\ude0a\n\nNossa equipe entrara em contato para *remarcar* seu horario.\n\nSe preferir, ligue: \ud83d\udcde 11 2524-9975\n\n_Affonso Odontologia_ \ud83e\uddb7');
    let avisoNao = '\u274c *PACIENTE DESMARCOU (pelo WhatsApp)*\n\n\ud83d\udc64 ' + nomeFb + '\n\ud83d\udcf1 ' + from;
    if (res && res.ok) {
      avisoNao += '\n\ud83d\udcc5 ' + res.date + ' as ' + res.time + (res.proc ? ' \u2014 ' + res.proc : '');
      avisoNao += '\n\n\u2714\ufe0f *Desmarcado automaticamente na agenda.*\n\ud83d\udd04 Ja aparece na aba REMARCAR. Ligar para remarcar!';
    } else {
      avisoNao += '\n\nRespondeu *NAO* ao lembrete.\n\u26a0\ufe0f Nao consegui atualizar o sistema (' + ((res && res.motivo) || 'verifique') + '). Desmarque manualmente e ligue para remarcar!';
    }
    await enviarMensagem(WHATSAPP_SECRETARIA, avisoNao);
  }
  return true;
}

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

app.options('/api/avisar', (req, res) => {
  setCors(res);
  res.sendStatus(200);
});

app.post('/api/avisar', async (req, res) => {
  setCors(res);
  try {
    const key = req.headers['x-api-key'] || (req.body && req.body.key);
    if (key !== DISPARO_KEY) {
      return res.status(401).json({ ok: false, error: 'não autorizado' });
    }
    const { texto } = req.body || {};
    if (!texto) {
      return res.status(400).json({ ok: false, error: 'texto é obrigatório' });
    }
    const ok = await enviarMensagem(WHATSAPP_SECRETARIA, String(texto));
    return res.json({ ok: !!ok });
  } catch (err) {
    console.error('Erro /api/avisar:', err);
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
          const textoBtn = msg.button?.text || msg.button?.payload || 'agendar';
          const msgTimestampBtn = parseInt(msg.timestamp) * 1000;
          if (Date.now() - msgTimestampBtn > 120000) return res.status(200).json({ status: 'ok' });
          const nomePerfilBtn = value?.contacts?.[0]?.profile?.name || '';
          const tratadoBtn = await processarRespostaConfirmacao(from, textoBtn, nomePerfilBtn);
          if (tratadoBtn) {
            ultimoEnvio[from] = Date.now();
            return res.status(200).json({ status: 'ok' });
          }
          await enviarMensagem(from,
            `Ótimo! 😊 Vou te conectar com nossa equipe agora.\n\n👉 Clique para conversar diretamente:\nhttps://wa.me/${WHATSAPP_SECRETARIA}?text=${encodeURIComponent('Olá! Vim pelo WhatsApp da Affonso Odontologia e gostaria de ' + textoBtn.toLowerCase() + '.')}`
          );
          return res.status(200).json({ status: 'ok' });
        }
        if (tipo !== 'text') return res.status(200).json({ status: 'ok' });
        const msgTimestamp = parseInt(msg.timestamp) * 1000;
        const agora = Date.now();
        const idadeMsg = agora - msgTimestamp;
        if (idadeMsg > 120000) return res.status(200).json({ status: 'ok' });
        const texto = msg.text?.body?.trim() || '';
        // ===== Confirmacao (SIM/NAO/1/2) — resposta digitada ao lembrete =====
        const nomePerfilTxt = value?.contacts?.[0]?.profile?.name || '';
        const tratadoTxt = await processarRespostaConfirmacao(from, texto, nomePerfilTxt);
        if (tratadoTxt) {
          ultimoEnvio[from] = agora;
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
