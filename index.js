<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Affonso Odontologia — Disparos WhatsApp</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; min-height: 100vh; padding: 20px; }
  .container { max-width: 520px; margin: 0 auto; }
  .header { background: #25D366; color: white; border-radius: 12px 12px 0 0; padding: 20px; display: flex; align-items: center; gap: 12px; }
  .header-icon { font-size: 28px; }
  .header h1 { font-size: 18px; font-weight: 600; }
  .header p { font-size: 13px; opacity: 0.85; margin-top: 2px; }
  .card { background: white; border-radius: 0 0 12px 12px; padding: 24px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
  .section-title { font-size: 13px; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; margin-top: 20px; }
  .section-title:first-child { margin-top: 0; }
  .field { margin-bottom: 14px; }
  label { font-size: 14px; color: #444; display: block; margin-bottom: 5px; font-weight: 500; }
  input, select { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 15px; color: #333; background: white; outline: none; transition: border-color 0.2s; }
  input:focus, select:focus { border-color: #25D366; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .templates { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 20px; }
  .template-opt { border: 1.5px solid #eee; border-radius: 10px; padding: 12px; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 8px; }
  .template-opt:hover { border-color: #25D366; background: #f0faf4; }
  .template-opt.selected { border-color: #25D366; background: #e8f9ef; }
  .template-opt .icon { font-size: 20px; }
  .template-opt .name { font-size: 13px; font-weight: 500; color: #333; }
  .template-opt .desc { font-size: 11px; color: #888; margin-top: 1px; }
  .preview { background: #f0faf4; border: 1px solid #c3e6cb; border-radius: 10px; padding: 14px; margin-bottom: 20px; display: none; }
  .preview-title { font-size: 12px; font-weight: 600; color: #25D366; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
  .preview-text { font-size: 14px; color: #333; line-height: 1.6; white-space: pre-wrap; }
  .btn { width: 100%; padding: 14px; background: #25D366; color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; }
  .btn:hover { background: #1ebe5d; }
  .btn:disabled { background: #aaa; cursor: not-allowed; }
  .result { margin-top: 16px; padding: 14px; border-radius: 10px; font-size: 14px; text-align: center; display: none; }
  .result.success { background: #e8f9ef; color: #1a7a3a; border: 1px solid #c3e6cb; }
  .result.error { background: #fdecea; color: #c0392b; border: 1px solid #f5c6cb; }
  .divider { height: 1px; background: #eee; margin: 20px 0; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="header-icon">🦷</div>
    <div>
      <h1>Affonso Odontologia</h1>
      <p>Painel de disparos WhatsApp</p>
    </div>
  </div>
  <div class="card">
    <div class="section-title">Dados do paciente</div>
    <div class="field">
      <label>Nome completo</label>
      <input type="text" id="nome" placeholder="Ex: Maria Silva" />
    </div>
    <div class="row">
      <div class="field">
        <label>WhatsApp</label>
        <input type="tel" id="telefone" placeholder="11 99999-9999" />
      </div>
      <div class="field">
        <label>Data da consulta</label>
        <input type="date" id="data" />
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label>Horário</label>
        <input type="time" id="hora" />
      </div>
      <div class="field">
        <label>Procedimento</label>
        <input type="text" id="procedimento" placeholder="Ex: Limpeza" />
      </div>
    </div>

    <div class="divider"></div>
    <div class="section-title">Tipo de mensagem</div>
    <div class="templates">
      <div class="template-opt" onclick="selectTemplate('confirmacao_consulta')" id="t_confirmacao_consulta">
        <div class="icon">✅</div>
        <div><div class="name">Confirmação</div><div class="desc">Consulta agendada</div></div>
      </div>
      <div class="template-opt" onclick="selectTemplate('lembrete_vespera')" id="t_lembrete_vespera">
        <div class="icon">🔔</div>
        <div><div class="name">Lembrete véspera</div><div class="desc">Dia anterior</div></div>
      </div>
      <div class="template-opt" onclick="selectTemplate('pos_cirurgia')" id="t_pos_cirurgia">
        <div class="icon">❤️</div>
        <div><div class="name">Pós-cirúrgico</div><div class="desc">Após procedimento</div></div>
      </div>
      <div class="template-opt" onclick="selectTemplate('pos_consulta')" id="t_pos_consulta">
        <div class="icon">⭐</div>
        <div><div class="name">Pós-consulta</div><div class="desc">Satisfação</div></div>
      </div>
      <div class="template-opt" onclick="selectTemplate('aniversario_paciente')" id="t_aniversario_paciente">
        <div class="icon">🎂</div>
        <div><div class="name">Aniversário</div><div class="desc">Parabéns</div></div>
      </div>
      <div class="template-opt" onclick="selectTemplate('controle_semestral')" id="t_controle_semestral">
        <div class="icon">📅</div>
        <div><div class="name">Retorno semestral</div><div class="desc">Lembrete retorno</div></div>
      </div>
      <div class="template-opt" onclick="selectTemplate('reagendamento')" id="t_reagendamento">
        <div class="icon">🔄</div>
        <div><div class="name">Reagendamento</div><div class="desc">Nova data</div></div>
      </div>
      <div class="template-opt" onclick="selectTemplate('orcamento_pendente')" id="t_orcamento_pendente">
        <div class="icon">💰</div>
        <div><div class="name">Orçamento</div><div class="desc">Pendente</div></div>
      </div>
    </div>

    <div class="preview" id="preview">
      <div class="preview-title">📱 Prévia da mensagem</div>
      <div class="preview-text" id="preview-text"></div>
    </div>

    <button class="btn" id="btnEnviar" onclick="enviar()" disabled>
      📤 Enviar mensagem
    </button>
    <div class="result" id="result"></div>
  </div>
</div>

<script>
const PHONE_NUMBER_ID = '1110427162151618';
const ACCESS_TOKEN = 'EAASoAO9Ee4ABRuTHfZBis9R9yb7iDzxKC3ZBMtuiKfLN7X6vOndkADuRZApTCisifRKt0TN2sEO6XfMH27GlUngp42LZB8K72MLzL003aQdFDap5sFTWS7BF93p61XaIR8so82ZBCMX3HYQTbwVZC2tHDGRAnACS8pJlpG6GO9dgMerUWOU5YzRT833ZCjrt9dvaAZDZD';

let templateSelecionado = null;

function selectTemplate(t) {
  document.querySelectorAll('.template-opt').forEach(el => el.classList.remove('selected'));
  document.getElementById('t_' + t).classList.add('selected');
  templateSelecionado = t;
  atualizarPreview();
  verificarBotao();
}

function formatarData(data) {
  if (!data) return '';
  const [ano, mes, dia] = data.split('-');
  return dia + '/' + mes + '/' + ano;
}

function atualizarPreview() {
  const nome = document.getElementById('nome').value || '[Nome]';
  const data = formatarData(document.getElementById('data').value) || '[Data]';
  const hora = document.getElementById('hora').value || '[Hora]';
  const proc = document.getElementById('procedimento').value || '[Procedimento]';

  const previews = {
    confirmacao_consulta: 'Olá, ' + nome + '! 😊\n\nSua consulta na Affonso Odontologia está confirmada!\n\n📅 Data: ' + data + '\n⏰ Horário: ' + hora + '\n🦷 Procedimento: ' + proc + '\n\nQualquer dúvida, estamos à disposição!',
    lembrete_vespera: 'Olá, ' + nome + '! 🔔\n\nLembrando que amanhã você tem consulta na Affonso Odontologia!\n\n📅 Data: ' + data + '\n⏰ Horário: ' + hora + '\n\nTe esperamos! 🦷',
    pos_cirurgia: 'Olá, ' + nome + '! ❤️\n\nEsperamos que esteja se recuperando bem após o procedimento de hoje.\n\nSeguindo as orientações do dentista você terá uma recuperação tranquila.\n\nQualquer dúvida, entre em contato conosco!',
    pos_consulta: 'Olá, ' + nome + '! ⭐\n\nObrigado por nos visitar hoje!\n\nGostaríamos de saber como foi sua experiência na Affonso Odontologia.\n\nSua opinião é muito importante para nós! 😊',
    aniversario_paciente: 'Olá, ' + nome + '! 🎂\n\nA equipe da Affonso Odontologia deseja a você um feliz aniversário!\n\nQue este dia seja repleto de alegrias e sorrisos! 😁🦷',
    controle_semestral: 'Olá, ' + nome + '! 📅\n\nJá se passaram 6 meses desde sua última visita à Affonso Odontologia.\n\nQue tal agendar seu retorno para manter sua saúde bucal em dia? 🦷',
    reagendamento: 'Olá, ' + nome + '! 🔄\n\nGostaríamos de reagendar sua consulta.\n\n📅 Nova data sugerida: ' + data + '\n⏰ Horário: ' + hora + '\n\nConfirme ou entre em contato!',
    orcamento_pendente: 'Olá, ' + nome + '! 💰\n\nPassando para lembrar que temos um orçamento pendente para o seu tratamento na Affonso Odontologia.\n\nFicamos à disposição para ajudá-lo! 🦷'
  };

  if (templateSelecionado && previews[templateSelecionado]) {
    document.getElementById('preview').style.display = 'block';
    document.getElementById('preview-text').textContent = previews[templateSelecionado];
  }
}

function verificarBotao() {
  const nome = document.getElementById('nome').value;
  const tel = document.getElementById('telefone').value;
  document.getElementById('btnEnviar').disabled = !(nome && tel && templateSelecionado);
}

document.querySelectorAll('input').forEach(el => {
  el.addEventListener('input', function() { atualizarPreview(); verificarBotao(); });
});

function limparTelefone(tel) {
  return '55' + tel.replace(/\D/g, '');
}

async function enviar() {
  const nome = document.getElementById('nome').value;
  const tel = limparTelefone(document.getElementById('telefone').value);
  const data = formatarData(document.getElementById('data').value);
  const hora = document.getElementById('hora').value;
  const proc = document.getElementById('procedimento').value || 'consulta';

  const btn = document.getElementById('btnEnviar');
  btn.disabled = true;
  btn.textContent = '⏳ Enviando...';

  const params = {
    confirmacao_consulta: [nome, 'Dr. Affonso', data, hora, proc],
    lembrete_vespera: [nome, 'Dr. Affonso', data, hora],
    pos_cirurgia: [nome, proc],
    pos_consulta: [nome],
    aniversario_paciente: [nome],
    controle_semestral: [nome],
    reagendamento: [nome, data, hora],
    orcamento_pendente: [nome, proc]
  };

  const body = {
    messaging_product: "whatsapp",
    to: tel,
    type: "template",
    template: {
      name: templateSelecionado,
      language: { code: "pt_BR" },
      components: [{
        type: "body",
        parameters: (params[templateSelecionado] || [nome]).map(p => ({ type: "text", text: p }))
      }]
    }
  };

  try {
    const res = await fetch('https://graph.facebook.com/v19.0/' + PHONE_NUMBER_ID + '/messages', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + ACCESS_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const data2 = await res.json();
    const resultEl = document.getElementById('result');
    resultEl.style.display = 'block';
    if (data2.messages) {
      resultEl.className = 'result success';
      resultEl.textContent = '✅ Mensagem enviada com sucesso para ' + nome + '!';
    } else {
      resultEl.className = 'result error';
      resultEl.textContent = '❌ Erro: ' + (data2.error?.message || 'Tente novamente');
    }
  } catch(e) {
    const resultEl = document.getElementById('result');
    resultEl.style.display = 'block';
    resultEl.className = 'result error';
    resultEl.textContent = '❌ Erro de conexão. Tente novamente.';
  }

  btn.disabled = false;
  btn.textContent = '📤 Enviar mensagem';
}
</script>
</body>
</html>
