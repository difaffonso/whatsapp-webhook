const express = require('express');
const cron = require('node-cron');
const app = express();

app.use(express.json());

const VERIFY_TOKEN = process.env.WHATSAPP_TOKEN || "affonso2025";
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_SECRETARIA = "5511987669852";
const DISPARO_KEY = process.env.DISPARO_KEY || VERIFY_TOKEN;

// ===== Supabase: atualizar status da consulta =====
const SUPA_URL = "https://ncfsepyzrqaljswjiuiv.supabase.co";
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jZnNlcHl6cnFhbGpzd2ppdWl2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1MTg1NzYsImV4cCI6MjA5NDA5NDU3Nn0.j_7sctB2bP0zljxPbh3Q4I_MzEksgL8PO5QNdzbaJDM"; // service_role via env (ignora RLS); anon como fallback

// normaliza telefone para comparar (so digitos, com/sem 55)
function soDigitos(s) { return String(s || '').replace(/[^0-9]/g, ''); }
function mesmoTelefone(a, b) {
  var da = soDigitos(a), db = soDigitos(b);
  if (!da || !db) return false;
  // compara os ultimos 8 digitos (ignora DDI/DDD divergentes)
  return da.slice(-8) === db.slice(-8);
}

// ===== Dedupe: Meta reenvia o webhook se a resposta demorar; processa cada mensagem 1x so =====
var __msgVistas = {};
function mensagemJaProcessada(id) {
  if (!id) return false;
  var agora = Date.now();
  for (var k in __msgVistas) { if (agora - __msgVistas[k] > 600000) delete __msgVistas[k]; }
  if (__msgVistas[id]) return true;
  __msgVistas[id] = agora;
  return false;
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

// ============================================================
// CARIMBO DE VERSAO (_vers) — correcao 14/07/2026: o app usa carimbos
// por chave (data._vers.appts, data._vers.waSent, ...) para saber O QUE
// baixar no poll de 8s. O servidor gravava appts/waSent SEM atualizar o
// carimbo -> nenhum aparelho baixava a mudanca -> o proximo save do app
// gravava a versao antiga por cima, apagando a confirmacao do paciente.
// Toda escrita do servidor no blob 'main' DEVE carimbar as chaves tocadas.
// ============================================================
function _bumpVers(dataObj, chaves) {
  var v = Object.assign({}, dataObj._vers || {});
  var agora = new Date().toISOString();
  (chaves || []).forEach(function (k) { v[k] = agora; });
  dataObj._vers = v;
  return dataObj;
}

// Monta o patch de status (carimbo _ts NOVO a cada chamada: vence o merge do app)
function montarPatchStatus(novoStatus) {  var patch = { status: novoStatus };
  patch._ts = Date.now(); // carimbo anti-overwrite: sem isso o app aberto reverte o status no proximo save/merge
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
  return patch;
}

// ============================================================
// VIGIA DE STATUS (correcao 14/07/2026): o app aberto na clinica salva
// o blob INTEIRO a cada alteracao. Se esse save acontecer na janela de
// segundos em que o servidor gravou a confirmacao/cancelamento do
// paciente (antes de o app ter puxado a mudanca no poll), o save do app
// REVERTE o status. Solucao: apos gravar, o servidor confere de novo
// aos 15s, 40s e 90s e REAPLICA se foi revertido — com _ts novo, que
// vence o merge do app. Reaplica SOMENTE se o status atual for
// pending/confirmed (estado pre-resposta): nunca briga com uma mudanca
// feita de proposito por um usuario na agenda (done, missed etc.).
// ============================================================
function _vigiarStatus(apptId, novoStatus) {
  var esperas = [15000, 40000, 90000];
  var passo = function (i) {
    if (i >= esperas.length) return;
    setTimeout(async function () {
      try {
        var data = await _lerClinicData();
        if (!data) return passo(i + 1);
        var appts = data.appts || [];
        var a = appts.find(function (x) { return x && x.id === apptId; });
        if (!a) return; // consulta removida: nao insiste
        if (a.status === novoStatus) return passo(i + 1); // ok, segue vigiando
        // revertido pelo app? so reaplica se voltou ao estado pre-resposta
        if (a.status !== 'pending' && a.status !== 'confirmed') return; // mudanca humana: respeita
        var novoAppts = appts.map(function (x) {
          if (!x || x.id !== apptId) return x;
          return Object.assign({}, x, montarPatchStatus(novoStatus));
        });
        var novoData = _bumpVers(Object.assign({}, data, { appts: novoAppts }), ['appts']); // carimba: app baixa a mudanca no proximo poll
        var rs = await fetch(SUPA_URL + "/rest/v1/clinic_data?id=eq.main", {
          method: "PATCH",
          headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Content-Type": "application/json", "Prefer": "return=minimal" },
          body: JSON.stringify({ data: novoData, updated_at: new Date().toISOString() })
        });
        console.log('[vigia] status da consulta ' + apptId + ' foi revertido pelo app; reaplicado "' + novoStatus + '" (tentativa ' + (i + 1) + '): ' + (rs.ok ? 'OK' : 'FALHOU'));
        passo(i + 1);
      } catch (e) { console.error('[vigia] erro:', e); passo(i + 1); }
    }, esperas[i]);
  };
  passo(0);
}

// Atualiza status da consulta de amanha (ou a mais proxima futura) do paciente
async function atualizarStatusConsulta(telefone, novoStatus) {
  try {
    // 1) achar paciente pelo telefone (tabela patients, separada do clinic_data)
    var pac = await buscarPacientePorTelefone(telefone);
    if (!pac || !pac.ids || !pac.ids.length) { console.log('[confirmacao] paciente nao encontrado para', telefone); return { ok: false, motivo: 'paciente nao encontrado' }; }
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
    if (!alvo) { console.log('[confirmacao] consulta nao encontrada para', telefone, 'ids:', JSON.stringify(pac.ids), 'candidatas:', candidatas.length); return { ok: false, motivo: 'consulta nao encontrada', nome: pac.nome }; }

    // 4) aplicar novo status
    var novoAppts = appts.map(function (a) {
      if (a.id !== alvo.id) return a;
      return Object.assign({}, a, montarPatchStatus(novoStatus));
    });
    var novoData = _bumpVers(Object.assign({}, data, { appts: novoAppts }), ['appts']); // carimba: app baixa a mudanca no proximo poll

    // 5) salvar de volta
    var rs = await fetch(SUPA_URL + "/rest/v1/clinic_data?id=eq.main", {
      method: "PATCH",
      headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Content-Type": "application/json", "Prefer": "return=minimal" },
      body: JSON.stringify({ data: novoData, updated_at: new Date().toISOString() })
    });
    if (!rs.ok) return { ok: false, motivo: 'falha ao salvar', nome: pac.nome };
    _vigiarStatus(alvo.id, novoStatus); // vigia em segundo plano: reaplica se o app sobrescrever
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
    await enviarMensagem(from, '\u2705 *Presença confirmada!*\n\nObrigado! Esperamos você. \ud83d\ude0a\n\n_Affonso Odontologia_ \ud83e\uddb7');
    let avisoSim = '\u2705 *PACIENTE CONFIRMOU*\n\n\ud83d\udc64 ' + nomeFb + '\n\ud83d\udcf1 ' + from;
    if (res && res.ok) {
      avisoSim += '\n\ud83d\udcc5 ' + res.date + ' as ' + res.time + (res.proc ? ' \u2014 ' + res.proc : '');
      avisoSim += '\n\n\u2714\ufe0f *Status atualizado para CONFIRMADO no sistema.*';
    } else {
      avisoSim += '\n\nRespondeu *SIM* ao lembrete.\n\u26a0\ufe0f Nao consegui atualizar o sistema automaticamente (' + ((res && res.motivo) || 'verifique') + '). Confirme manualmente.';
    }
    await enviarMensagem(WHATSAPP_SECRETARIA, avisoSim);
  } else {
    await enviarMensagem(from, 'Tudo bem! \ud83d\ude0a\n\nNossa equipe entrará em contato para *remarcar* seu horário.\n\nSe preferir, ligue: \ud83d\udcde 11 2524-9975\n\n_Affonso Odontologia_ \ud83e\uddb7');
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

// ===== Conversas: salvar mensagem na tabela wa_messages (NUNCA quebra o fluxo) =====
async function salvarMensagem(direction, telefone, texto, extra) {
  try {
    var ph = soDigitos(telefone);
    if (!ph) return;
    var obj = Object.assign({
      phone: ph,
      direction: direction,
      body: (texto == null ? '' : String(texto)).slice(0, 4000),
      ts: new Date().toISOString()
    }, extra || {});
    await fetch(SUPA_URL + "/rest/v1/wa_messages", {
      method: "POST",
      headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Content-Type": "application/json", "Prefer": "return=minimal" },
      body: JSON.stringify(obj)
    });
  } catch (e) { console.error('salvarMensagem erro:', e); }
}
// ===== Conversas: atualizar status (entregue/lido) de uma mensagem ja enviada =====
async function atualizarStatusMensagem(wamid, status) {
  try {
    if (!wamid) return;
    if (status !== 'delivered' && status !== 'read' && status !== 'failed') return;
    var filtro = "wamid=eq." + encodeURIComponent(wamid);
    if (status === 'delivered') filtro += "&status=neq.read"; // nao rebaixar de lido para entregue
    await fetch(SUPA_URL + "/rest/v1/wa_messages?" + filtro, {
      method: "PATCH",
      headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Content-Type": "application/json", "Prefer": "return=minimal" },
      body: JSON.stringify({ status: status })
    });
  } catch (e) { console.error('atualizarStatusMensagem erro:', e); }
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
    if (soDigitos(para) !== soDigitos(WHATSAPP_SECRETARIA)) {
      var _wamid = data && data.messages && data.messages[0] && data.messages[0].id;
      salvarMensagem('out', para, texto, _wamid ? { status: 'sent', wamid: _wamid } : { status: 'sent' });
    }
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
          var _wamidT = data.messages && data.messages[0] && data.messages[0].id;
          var _corpo = "\ud83d\udcf2 Lembrete de confirmacao" + (base && base.length ? (": " + base.join(" \u00b7 ")) : "");
          salvarMensagem('out', to, _corpo, { status: 'sent', wamid: _wamidT, patient_name: (base && base[0]) ? String(base[0]) : null });
          return { ok: true, lang: lang, id: _wamidT };
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
  // Ack imediato: a Meta reenvia o webhook se a resposta demorar; respondemos 200 ja
  // e seguimos processando. As chamadas res.* abaixo viram no-op (evita erro de resposta dupla).
  res.status(200).json({ status: 'ok' });
  res.status = function () { return res; };
  res.json = function () { return res; };
  res.sendStatus = function () { return res; };
  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      if (value?.statuses) {
        try {
          for (var si = 0; si < value.statuses.length; si++) {
            var st = value.statuses[si];
            if (st && st.id && st.status) atualizarStatusMensagem(st.id, st.status);
          }
        } catch (e) { console.error('status webhook erro:', e); }
        return res.status(200).json({ status: 'ok' });
      }
      const messages = value?.messages;
      if (messages && messages.length > 0) {
        const msg = messages[0];
        const from = msg.from;
        const tipo = msg.type;
        // Reentrega da Meta (mesmo wamid): ja processada -> responde ok e nao repete nada
        if (msg.id && mensagemJaProcessada(msg.id)) return res.status(200).json({ status: 'ok' });
        // Conversas: salvar TODA mensagem recebida (a prova de falha; nao depende dos filtros de acao)
        var _txtIn = '';
        if (tipo === 'text') _txtIn = (msg.text && msg.text.body) || '';
        else if (tipo === 'button') _txtIn = (msg.button && (msg.button.text || msg.button.payload)) || '';
        else if (tipo === 'interactive') _txtIn = (msg.interactive && ((msg.interactive.button_reply && msg.interactive.button_reply.title) || (msg.interactive.list_reply && msg.interactive.list_reply.title))) || '';
        else _txtIn = '[' + tipo + ']';
        var _nomeIn = (value && value.contacts && value.contacts[0] && value.contacts[0].profile && value.contacts[0].profile.name) || null;
        salvarMensagem('in', from, _txtIn, { status: 'received', wamid: msg.id || null, patient_name: _nomeIn });
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
          // ── Botão Confirmar/Desmarcar sem consulta futura localizada (ex.: telefone divergente no cadastro) ──
          var normBtn = String(textoBtn || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
          if (normBtn.indexOf('confirm') >= 0 || normBtn.indexOf('desmarc') >= 0 || normBtn.indexOf('remarc') >= 0 || normBtn.indexOf('cancel') >= 0) {
            await enviarMensagem(from, 'Recebemos sua resposta! \ud83d\ude0a\n\nPorém não localizamos uma consulta futura vinculada a este número de WhatsApp.\n\nSe acha que houve um engano, fale com nossa equipe:\n\ud83d\udc49 ' + linkWhatsApp('Olá! Respondi ao lembrete de consulta, mas não localizaram meu agendamento.') + '\n\n_Affonso Odontologia_ \ud83e\uddb7');
            await enviarMensagem(WHATSAPP_SECRETARIA, '\u26a0\ufe0f *RESPOSTA AO LEMBRETE SEM CONSULTA LOCALIZADA*\n\n\ud83d\udc64 ' + (nomePerfilBtn || 'Paciente') + '\n\ud83d\udcf1 ' + from + '\n\ud83d\udd18 Tocou em: ' + textoBtn + '\n\nNão achei consulta futura (Pendente/Confirmada) para este número. Verifique o telefone no cadastro e confirme manualmente com o paciente.');
            ultimoEnvio[from] = Date.now();
            return res.status(200).json({ status: 'ok' });
          }
          // ── Botões da pesquisa de satisfação (pós-consulta): apenas agradecer ──
          if (normBtn === 'otimo' || normBtn === 'otima' || normBtn === 'boa' || normBtn === 'bom' || normBtn.indexOf('insatisf') >= 0) {
            if (normBtn.indexOf('insatisf') >= 0) {
              await enviarMensagem(from, 'Obrigado pelo seu retorno. \ud83d\ude4f\n\nSentimos muito que a experiência não tenha sido como você esperava. Queremos entender e melhorar — se puder, fale com nossa equipe:\n\ud83d\udc49 ' + linkWhatsApp('Olá! Respondi à pesquisa de satisfação e gostaria de falar sobre meu atendimento.') + '\n\n_Affonso Odontologia_ \ud83e\uddb7');
            } else {
              await enviarMensagem(from, 'Muito obrigado pelo seu retorno! \ud83d\udc9a\n\nFicamos felizes em cuidar do seu sorriso. Até a próxima! \ud83d\ude0a\n\n_Affonso Odontologia_ \ud83e\uddb7');
            }
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

// Diagnostico: mostra o que o webhook enxerga para um telefone (protegido pela DISPARO_KEY)
app.get('/api/diag', async (req, res) => {
  try {
    if ((req.query.key || '') !== DISPARO_KEY) return res.status(403).json({ ok: false, error: 'key invalida' });
    var fone = String(req.query.fone || '');
    var out = { fone: fone, usandoServiceKey: !!process.env.SUPABASE_SERVICE_KEY };
    var sp = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    out.hoje = sp.toISOString().split('T')[0];
    var pac = await buscarPacientePorTelefone(fone);
    out.paciente = pac ? { nome: pac.nome, ids: pac.ids } : null;
    var r = await fetch(SUPA_URL + "/rest/v1/clinic_data?id=eq.main&select=data", {
      headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY }
    });
    var rows = await r.json();
    var data = (rows && rows[0] && rows[0].data) || null;
    out.clinicDataOk = !!data;
    var appts = (data && data.appts) || [];
    out.totalConsultas = appts.length;
    if (pac && pac.ids && pac.ids.length) {
      var idSet = {};
      pac.ids.forEach(function (i) { idSet[Number(i)] = true; });
      out.consultasDoPaciente = appts.filter(function (a) { return idSet[Number(a.patientId)]; })
        .map(function (a) { return { id: a.id, date: a.date, time: a.time, status: a.status, patientId: a.patientId }; });
    }
    return res.json(out);
  } catch (e) { return res.status(500).json({ ok: false, error: String(e && e.message) }); }
});

app.get('/', (req, res) => {
  res.send('WhatsApp Webhook ativo!');
});


// ============================================================
// AGENDADOR: envios automáticos diários pelo próprio servidor
// (véspera, aniversário, semestral, pós-cirurgia, pós-consulta,
// orçamento). Roda todo dia às 12h (horário de São Paulo),
// independente do app estar aberto. Replica as MESMAS regras do app.
// ============================================================

// Limite de mensagens por tipo por dia (proteção de custo/bloqueio da Meta).
// Ajuste pela variável de ambiente WA_MAX_POR_TIPO se precisar de mais.
const WA_MAX_POR_TIPO = Number(process.env.WA_MAX_POR_TIPO) || 100;

// Datas no fuso de São Paulo (Brasil sem horário de verão -> offset fixo -03).
function _spDateStr(offsetDays) {
  var d = new Date(Date.now() + (offsetDays || 0) * 86400000);
  var p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  var g = function (t) { return (p.find(function (x) { return x.type === t; }) || {}).value; };
  return g('year') + '-' + g('month') + '-' + g('day');
}
function _fmtBR(ymd) { if (!ymd) return '-'; var s = String(ymd).split('-'); return s.length === 3 ? (s[2] + '/' + s[1] + '/' + s[0]) : ymd; }
function _moN(ymd, n) { var x = new Date(ymd + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + (Number(n) || 6)); return x.toISOString().split('T')[0]; }
function _retMonths(p) { var m = Number(p && p.retMeses); return (m && m > 0) ? m : 6; }
function _retDue(p, lastDate) { if (!lastDate) return null; if (p && p.retData && p.retData >= lastDate) return p.retData; return _moN(lastDate, _retMonths(p)); }
function _diasEntre(aYmd, bYmd) { return Math.floor((new Date(aYmd + 'T12:00:00Z') - new Date(bYmd + 'T12:00:00Z')) / 86400000); }
function _normFone(fone) { var to = soDigitos(fone); if (to.length === 11 || to.length === 10) to = '55' + to; return to; }

// procedimentos considerados cirúrgicos (mesma lista do app)
var PCIR_WA = ["extra", "exodont", "cirurg", "implante", "enxerto", "sinus", "frenectomia", "apicectomia", "biopsia", "gengivo"];

async function _lerClinicData() {
  var r = await fetch(SUPA_URL + "/rest/v1/clinic_data?id=eq.main&select=data", {
    headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY }
  });
  var rows = await r.json();
  return (rows && rows[0] && rows[0].data) || null;
}

// Carrega TODOS os pacientes (tabela patients). porId aceita id do registro E data.id.
async function _carregarPacientes() {
  var lista = [], porId = {};
  var lastId = 0, step = 1000;
  for (var guard = 0; guard < 500; guard++) {
    var r = await fetch(SUPA_URL + "/rest/v1/patients?select=id,data&order=id.asc&limit=" + step + "&id=gt." + lastId, {
      headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY }
    });
    if (!r.ok) break;
    var rows = await r.json();
    if (!rows || !rows.length) break;
    for (var k = 0; k < rows.length; k++) {
      var pd = rows[k].data; if (!pd) continue;
      var ids = [];
      if (rows[k].id != null) ids.push(Number(rows[k].id));
      if (pd.id != null) ids.push(Number(pd.id));
      ids = ids.filter(function (v, i, a) { return !isNaN(v) && a.indexOf(v) === i; });
      lista.push({ p: pd, ids: ids });
      ids.forEach(function (i) { if (porId[i] === undefined) porId[i] = pd; });
    }
    lastId = rows[rows.length - 1].id;
    if (rows.length < step) break;
  }
  return { lista: lista, porId: porId };
}

// Monta a fila de envios (mesmas regras do app). Não envia — só decide quem recebe o quê.
function _montarFila(data, pacientes, t, tm, y) {
  var cfg = data.waAuto || {};
  var sent = Object.assign({}, data.waSent || {});
  var dents = data.dents || [];
  var appts = data.appts || [];
  var recs = data.recs || [];
  var budgets = data.budgets || [];
  var dOf = function (id) { return dents.find(function (x) { return x.id === Number(id); }) || dents[0] || { name: "Diego Affonso" }; };

  var logHoje = {};
  (data.waAutoLog || []).forEach(function (l) { if ((l.ts || '').slice(0, 10) === t) logHoje[l.tipo] = (logHoje[l.tipo] || 0) + 1; });

  var fila = [];
  var jaNaFila = {};
  var addJob = function (tipoLabel, key, template, fone, params, patName) {
    if (!fone) return;
    if (sent[key] || jaNaFila[key]) return;
    if ((logHoje[tipoLabel] || 0) >= WA_MAX_POR_TIPO) return;
    logHoje[tipoLabel] = (logHoje[tipoLabel] || 0) + 1;
    jaNaFila[key] = true;
    fila.push({ tipoLabel: tipoLabel, key: key, template: template, fone: _normFone(fone), params: params, patName: patName });
  };

  // 1) VÉSPERA — consultas de amanhã, Pendente/Confirmada
  if (cfg.vespera) {
    appts.forEach(function (a) {
      if (a.date !== tm || a.blocked) return;
      if (a.status !== 'pending' && a.status !== 'confirmed') return;
      var p = pacientes.porId[Number(a.patientId)]; if (!p || !p.phone) return;
      var d = dOf(a.dentistId);
      addJob("Véspera", "v_" + a.id + "_" + a.date, "lembrete_vespera", p.phone, [p.name, _fmtBR(a.date), a.time, d.name], p.name);
    });
  }

  // 2) ANIVERSÁRIO — aniversariantes de hoje
  if (cfg.aniversario) {
    var ano = t.slice(0, 4);
    pacientes.lista.forEach(function (reg) {
      var p = reg.p;
      if (!p.dob || p.dob.slice(5) !== t.slice(5)) return;
      if (!p.phone) return;
      var pid = (p.id != null) ? p.id : reg.ids[0];
      addJob("Aniversário", "a_" + pid + "_" + ano, "aniversario_paciente", p.phone, [p.name], p.name);
    });
  }

  // 3) SEMESTRAL — 6 meses após último atend. pago, sem consulta futura
  if (cfg.semestral) {
    pacientes.lista.forEach(function (reg) {
      var p = reg.p; if (!p.phone) return;
      var idSet = {}; reg.ids.forEach(function (i) { idSet[i] = true; });
      var last = recs.filter(function (r) { return idSet[Number(r.patientId)] && r.paid > 0; }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); })[0];
      if (!last) return;
      if (_retDue(p, last.date) > t) return;
      var fut = appts.find(function (a) { return idSet[Number(a.patientId)] && a.date >= t && a.status !== 'cancelled' && a.status !== 'missed'; });
      if (fut) return;
      var d = dOf(last.dentistId);
      var pid = (p.id != null) ? p.id : reg.ids[0];
      addJob("Semestral", "s_" + pid, "controle_semestral", p.phone, [p.name, d.name], p.name);
    });
  }

  // 4) PÓS-CIRURGIA / PÓS-CONSULTA — consultas de ontem (done/confirmed)
  if (cfg.poscirurgia || cfg.posconsulta) {
    appts.forEach(function (a) {
      if (a.date !== y || a.blocked) return;
      if (a.status !== 'done' && a.status !== 'confirmed') return;
      var p = pacientes.porId[Number(a.patientId)]; if (!p || !p.phone) return;
      var pid = (p.id != null) ? p.id : Number(a.patientId);
      var isCir = PCIR_WA.some(function (w) { return (a.procedure || '').toLowerCase().indexOf(w) >= 0; });
      var d = dOf(a.dentistId);
      if (isCir && cfg.poscirurgia) {
        addJob("Pós-cirurgia", "pc_" + a.id, "pos__procedimento_", p.phone, [p.name, d.name, a.procedure || 'procedimento'], p.name);
      } else if (!isCir && cfg.posconsulta && a.status === 'done') {
        var psk = "ps_" + pid;
        var psLast = sent[psk];
        var psDias = psLast ? _diasEntre(t, psLast) : 99999;
        if (psDias >= 180) { delete sent[psk]; addJob("Pós-consulta", psk, "pos__consulta", p.phone, [p.name, d.name], p.name); }
      }
    });
  }

  // 5) ORÇAMENTO — orçamentos Em espera há 3+ dias
  if (cfg.orcamento) {
    var limS = _spDateStr(-3);
    budgets.forEach(function (b) {
      if (b.status !== 'pending') return;
      if ((b.date || '') > limS) return;
      var p = pacientes.porId[Number(b.patientId)]; if (!p || !p.phone) return;
      var d = dOf(b.dentistId);
      addJob("Orçamento", "o_" + b.id, "orcamento_pendente", p.phone, [p.name, d.name], p.name);
    });
  }

  return fila;
}

// Remove chaves antigas do waSent (mesma retenção do app), para não crescer sem fim.
function _purgarWaSent(sent, t) {
  var keep = {};
  Object.keys(sent || {}).forEach(function (k) {
    var ds = sent[k];
    var dias = _diasEntre(t, ds);
    var max = k.slice(0, 3) === 'ps_' ? 190 : (k.slice(0, 2) === 'a_' ? 400 : (k.slice(0, 2) === 's_' ? 200 : 120));
    if (dias <= max) keep[k] = ds;
  });
  return keep;
}

// Grava SOMENTE waSent + waAutoLog, relendo o blob na hora (merge seguro, não sobrescreve o app).
async function _gravarWa(waSentNovo, novosLogs, purgar) {
  try {
    var atual = await _lerClinicData();
    if (!atual) return false;
    var waSent = Object.assign({}, atual.waSent || {}, waSentNovo || {});
    if (purgar) waSent = _purgarWaSent(waSent, _spDateStr(0));
    var log = (novosLogs || []).concat(atual.waAutoLog || []).slice(0, 300);
    var novoData = _bumpVers(Object.assign({}, atual, { waSent: waSent, waAutoLog: log }), ['waSent', 'waAutoLog']); // carimba: app baixa e nao apaga as marcacoes do servidor
    var rs = await fetch(SUPA_URL + "/rest/v1/clinic_data?id=eq.main", {
      method: "PATCH",
      headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Content-Type": "application/json", "Prefer": "return=minimal" },
      body: JSON.stringify({ data: novoData, updated_at: new Date().toISOString() })
    });
    return rs.ok;
  } catch (e) { console.error('_gravarWa erro:', e); return false; }
}

// ============================================================
// DEDUP DO SERVIDOR (correção véspera duplicada — 14/07/2026):
// o waSent dentro do blob 'main' pode ser apagado pelo app aberto
// (save de blob inteiro sobrescreve as marcações feitas pelo servidor).
// Por isso o servidor mantém uma CÓPIA PRÓPRIA das marcações num
// registro separado (id='wa_sent_srv') na mesma tabela clinic_data,
// que o app NUNCA lê nem grava. Antes de qualquer envio automático,
// o servidor consulta as DUAS fontes (blob + registro próprio).
// ============================================================
async function _lerSentSrv() {
  try {
    var r = await fetch(SUPA_URL + "/rest/v1/clinic_data?id=eq.wa_sent_srv&select=data", {
      headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY }
    });
    if (!r.ok) return {};
    var rows = await r.json();
    return (rows && rows[0] && rows[0].data) || {};
  } catch (e) { console.error('_lerSentSrv erro:', e); return {}; }
}

async function _gravarSentSrv(novos, purgar) {
  try {
    if ((!novos || !Object.keys(novos).length) && !purgar) return true;
    var atual = await _lerSentSrv();
    var m = Object.assign({}, atual, novos || {});
    if (purgar) m = _purgarWaSent(m, _spDateStr(0));
    // upsert: cria o registro na primeira vez, atualiza nas seguintes
    var rs = await fetch(SUPA_URL + "/rest/v1/clinic_data?on_conflict=id", {
      method: "POST",
      headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: "wa_sent_srv", data: m, updated_at: new Date().toISOString() })
    });
    if (!rs.ok) console.error('_gravarSentSrv falhou:', rs.status);
    return rs.ok;
  } catch (e) { console.error('_gravarSentSrv erro:', e); return false; }
}

// Execução principal. dry=true -> só simula (não envia, não grava).
async function rodarAutomaticos(dry) {
  var t = _spDateStr(0), tm = _spDateStr(1), y = _spDateStr(-1);
  var data = await _lerClinicData();
  if (!data) return { ok: false, erro: 'clinic_data indisponível' };
  var cfg = data.waAuto || {};
  if (!cfg.master) return { ok: true, pulado: 'interruptor geral (master) desligado', resumo: {} };

  // dedup do servidor: une as marcações próprias (que o app não consegue apagar) às do blob
  var sentSrv = await _lerSentSrv();
  data.waSent = Object.assign({}, data.waSent || {}, sentSrv);

  var pacientes = await _carregarPacientes();
  _patCache = { porId: pacientes.porId, ts: Date.now() };
  var fila = _montarFila(data, pacientes, t, tm, y);

  var resumo = {};
  fila.forEach(function (j) { resumo[j.tipoLabel] = (resumo[j.tipoLabel] || 0) + 1; });

  if (dry) {
    return {
      ok: true, dry: true, datas: { hoje: t, amanha: tm, ontem: y }, totalPacientes: pacientes.lista.length,
      resumo: resumo, totalFila: fila.length,
      itens: fila.map(function (j) { return { tipo: j.tipoLabel, pat: j.patName, fone: j.fone, template: j.template }; })
    };
  }

  var enviados = 0, erros = 0;
  var waSentNovo = {}, novosLogs = [], pendentes = 0;
  for (var i = 0; i < fila.length; i++) {
    var j = fila[i];
    var r = await enviarTemplate(j.fone, j.template, j.params);
    var okEnvio = !!(r && r.ok);
    if (okEnvio) { enviados++; waSentNovo[j.key] = t; }
    novosLogs.push({ ts: new Date().toISOString(), tipo: j.tipoLabel, pat: j.patName, fone: j.fone, ok: okEnvio, err: (r && r.error) || '' });
    console.log('[auto] ' + (okEnvio ? 'OK' : 'ERRO') + ' ' + j.tipoLabel + ' ' + j.patName + ' ' + j.fone + (okEnvio ? '' : (' :: ' + ((r && r.error) || '?'))));
    pendentes++;
    if (pendentes >= 20) { await _gravarWa(waSentNovo, novosLogs, false); await _gravarSentSrv(waSentNovo, false); waSentNovo = {}; novosLogs = []; pendentes = 0; }
    await new Promise(function (res) { setTimeout(res, 1300); });
  }
  await _gravarWa(waSentNovo, novosLogs, true); // grava o restante + purga chaves antigas
  await _gravarSentSrv(waSentNovo, true); // grava também na cópia do servidor (à prova de overwrite do app)
  return { ok: true, datas: { hoje: t, amanha: tm, ontem: y }, resumo: resumo, enviados: enviados, erros: erros, totalFila: fila.length };
}

// Endpoint manual (protegido pela DISPARO_KEY):
//   Simular (não envia):  GET /api/rodar-automaticos?key=SUA_KEY&dry=1
//   Rodar de verdade:     GET /api/rodar-automaticos?key=SUA_KEY
app.get('/api/rodar-automaticos', async (req, res) => {
  try {
    if ((req.query.key || '') !== DISPARO_KEY) return res.status(403).json({ ok: false, error: 'key invalida' });
    var dry = String(req.query.dry || '') === '1' || String(req.query.dry || '').toLowerCase() === 'true';
    if (dry) { var out = await rodarAutomaticos(true); return res.json(out); }
    rodarAutomaticos(false).then(function (r) {
      console.log('[auto/manual] fim:', JSON.stringify({ resumo: r.resumo, enviados: r.enviados, erros: r.erros }));
    }).catch(function (e) { console.error('[auto/manual] erro:', e); });
    return res.json({ ok: true, iniciado: true, aviso: 'Envio real rodando em segundo plano. Veja o resultado em Administrativo > WhatsApp (log) ou nos Logs do Railway.' });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e && e.message) }); }
});

// Agendador diário: todo dia às 12h00 (horário de São Paulo).
cron.schedule('0 12 * * *', function () {
  console.log('[auto] disparando envios automáticos das 12h (SP)...');
  rodarAutomaticos(false).then(function (r) {
    console.log('[auto] concluido:', JSON.stringify(r && { resumo: r.resumo, enviados: r.enviados, erros: r.erros, pulado: r.pulado }));
  }).catch(function (e) { console.error('[auto] erro no agendador:', e); });
}, { timezone: 'America/Sao_Paulo' });


// ============================================================
// VARREDURA LEVE DE VÉSPERA (além do lote das 12h)
// Pega consultas de amanhã marcadas DEPOIS das 12h. Roda de hora
// em hora, das 13h às 20h. Lê só o necessário (NÃO os 10 mil pacientes):
// usa um cache de pacientes em memória, atualizado no lote das 12h.
// ============================================================
var _patCache = { porId: {}, ts: 0 };
async function _atualizarCachePacientes() {
  try {
    var pac = await _carregarPacientes();
    _patCache = { porId: pac.porId, ts: Date.now() };
    console.log('[auto] cache de pacientes atualizado:', pac.lista.length);
  } catch (e) { console.error('[auto] erro ao atualizar cache de pacientes:', e); }
}

async function rodarVespera() {
  try {
    var t = _spDateStr(0), tm = _spDateStr(1);
    // lê SÓ os campos necessários do blob (sub-path JSONB) — leve, não baixa o blob inteiro
    var r = await fetch(SUPA_URL + "/rest/v1/clinic_data?id=eq.main&select=appts:data->appts,waSent:data->waSent,waAuto:data->waAuto,dents:data->dents,waAutoLog:data->waAutoLog", {
      headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY }
    });
    var rows = await r.json();
    var d0 = rows && rows[0]; if (!d0) return;
    var cfg = d0.waAuto || {};
    if (!cfg.master || !cfg.vespera) return;
    var appts = d0.appts || [], sent = d0.waSent || {}, dents = d0.dents || [];
    // correção véspera duplicada: o waSent do blob pode ter sido sobrescrito pelo app
    // (apagando as marcações do servidor). Une a cópia PRÓPRIA do servidor, que o app não toca.
    var sentSrv = await _lerSentSrv();
    sent = Object.assign({}, sent, sentSrv);
    var dOf = function (id) { return dents.find(function (x) { return x.id === Number(id); }) || dents[0] || { name: "Diego Affonso" }; };
    var jaHoje = 0;
    (d0.waAutoLog || []).forEach(function (l) { if ((l.ts || '').slice(0, 10) === t && l.tipo === 'Véspera') jaHoje++; });

    // consultas de amanhã, elegíveis e que AINDA não receberam o lembrete
    var alvos = appts.filter(function (a) {
      return a.date === tm && !a.blocked && (a.status === 'pending' || a.status === 'confirmed') && !sent['v_' + a.id + '_' + a.date];
    });
    if (!alvos.length) return;

    if (!_patCache.ts) await _atualizarCachePacientes();
    var porId = _patCache.porId || {};

    var enviados = 0, waSentNovo = {}, novosLogs = [];
    for (var i = 0; i < alvos.length; i++) {
      if (jaHoje + enviados >= WA_MAX_POR_TIPO) break;
      var a = alvos[i];
      var p = porId[Number(a.patientId)];
      if (!p || !p.phone) continue; // paciente novo fora do cache: já recebeu a Confirmação ao agendar
      var d = dOf(a.dentistId);
      var fone = _normFone(p.phone);
      var rr = await enviarTemplate(fone, 'lembrete_vespera', [p.name, _fmtBR(a.date), a.time, d.name]);
      var ok = !!(rr && rr.ok);
      if (ok) { enviados++; waSentNovo['v_' + a.id + '_' + a.date] = t; }
      novosLogs.push({ ts: new Date().toISOString(), tipo: 'Véspera', pat: p.name, fone: fone, ok: ok, err: (rr && rr.error) || '' });
      console.log('[auto/vespera] ' + (ok ? 'OK' : 'ERRO') + ' ' + p.name + ' ' + fone + (ok ? '' : (' :: ' + ((rr && rr.error) || '?'))));
      await new Promise(function (res) { setTimeout(res, 1300); });
    }
    if (novosLogs.length) {
      await _gravarWa(waSentNovo, novosLogs, false);
      await _gravarSentSrv(waSentNovo, false); // cópia do servidor: garante que a próxima varredura NÃO reenvia
    }
  } catch (e) { console.error('[auto/vespera] erro:', e); }
}

// Varreduras de véspera: de hora em hora, das 13h às 20h (SP) — pegam marcações feitas depois do lote das 12h.
cron.schedule('0 13-20 * * *', function () {
  console.log('[auto/vespera] varredura horaria...');
  rodarVespera();
}, { timezone: 'America/Sao_Paulo' });

// aquece o cache de pacientes ao subir o servidor (varreduras já funcionam antes do lote das 12h)
_atualizarCachePacientes();

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
