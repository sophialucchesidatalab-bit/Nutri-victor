require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const Anthropic  = require('@anthropic-ai/sdk');
const dayjs      = require('dayjs');
const customParse = require('dayjs/plugin/customParseFormat');
const { google } = require('googleapis');

dayjs.extend(customParse);

const app = express();
app.use(express.json());

// ── CONFIG ────────────────────────────────────────────────
const EVOLUTION_URL      = process.env.EVOLUTION_URL;
const EVOLUTION_KEY      = process.env.EVOLUTION_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'victor';
const CALENDAR_ID        = process.env.GOOGLE_CALENDAR_ID;
const SHEET_ID           = process.env.SHEET_ID;
const ANTHROPIC_KEY      = process.env.ANTHROPIC_API_KEY;

const claude = new Anthropic({ apiKey: ANTHROPIC_KEY });

// Locais disponíveis
const LOCAIS = {
  'maxfit':  { nome: 'Maxfit',  endereco: 'R. Mario Piragibe, 26 - Méier, Rio de Janeiro' },
  'copa':    { nome: 'Copa',    endereco: 'Praça Serzedelo Corrêa, 15 - 703 - Copacabana, Rio de Janeiro' },
  'online':  { nome: 'Online',  endereco: 'Online (link será enviado em breve)' },
};

// Histórico de conversa por telefone: { [tel]: [{role, content}] }
const historicos = {};

// ── SYSTEM PROMPT DO AGENTE ───────────────────────────────
const SYSTEM_PROMPT = `Você é o assistente virtual de agendamento do nutricionista Victor Afonso.
Seu trabalho é agendar consultas de forma amigável e eficiente.

INFORMAÇÕES DO CONSULTÓRIO:
- Nutricionista: Victor Afonso
- Locais disponíveis:
  1. Maxfit — Méier, R. Mario Piragibe, 26
  2. Copa — Copacabana, Praça Serzedelo Corrêa, 15 - sala 703
  3. Online — por videochamada

INSTRUÇÕES:
1. Cumprimente o paciente de forma cordial
2. Colete as seguintes informações NA ORDEM abaixo:
   - Nome completo
   - Data desejada (peça no formato DD/MM/AAAA)
   - Horário desejado (peça no formato HH:MM)
   - Local preferido (Maxfit, Copa ou Online)
3. Após coletar TODOS os dados, mostre um resumo e peça confirmação
4. Quando o paciente confirmar, responda EXATAMENTE neste formato JSON (e nada mais):
   AGENDAR:{"nome":"...","data":"DD/MM/AAAA","horario":"HH:MM","local":"maxfit|copa|online"}
5. Se o paciente quiser cancelar ou recomeçar, seja gentil e recomece do zero

REGRAS:
- Seja sempre simpático e profissional
- Se o paciente escrever de forma informal, responda no mesmo tom mas mantenha a cordialidade
- Não invente horários disponíveis — apenas colete os dados e confirme
- Se alguma informação estiver incompleta ou confusa, peça para o paciente repetir
- Fale sempre em português brasileiro
- Nunca mencione que é uma IA`;

// ── GOOGLE AUTH ───────────────────────────────────────────
function getGoogleAuth() {
  const credentials = process.env.GOOGLE_CREDENTIALS
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS)
    : require('./credentials.json');
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
}

// ── ENVIAR MENSAGEM WHATSAPP ──────────────────────────────
async function enviar(telefone, texto) {
  try {
    await axios.post(
      `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      { number: telefone, text: texto },
      { headers: { apikey: EVOLUTION_KEY, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('Erro ao enviar:', e.response?.data || e.message);
  }
}

// ── CRIAR EVENTO NO GOOGLE CALENDAR ──────────────────────
async function criarEvento(dados) {
  const auth    = getGoogleAuth();
  const client  = await auth.getClient();
  const calendar = google.calendar({ version: 'v3', auth: client });

  const dataHora = dayjs(`${dados.data} ${dados.horario}`, 'DD/MM/YYYY HH:mm');
  const local    = LOCAIS[dados.local.toLowerCase()] || LOCAIS['online'];

  await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource: {
      summary:     `Consulta — ${dados.nome}`,
      location:    local.endereco,
      description: `Paciente: ${dados.nome}\nTelefone: ${dados.telefone}\nLocal: ${local.nome}`,
      start: { dateTime: dataHora.toISOString(),                    timeZone: 'America/Sao_Paulo' },
      end:   { dateTime: dataHora.add(1, 'hour').toISOString(),     timeZone: 'America/Sao_Paulo' },
    },
  });
}

// ── REGISTRAR NA PLANILHA ─────────────────────────────────
async function registrarPlanilha(dados) {
  const auth   = getGoogleAuth();
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                 'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const mes   = dayjs(dados.data, 'DD/MM/YYYY');
  const aba   = meses[mes.month()];
  const local = LOCAIS[dados.local.toLowerCase()] || LOCAIS['online'];

  await sheets.spreadsheets.values.append({
    spreadsheetId:    SHEET_ID,
    range:            `${aba}!A:N`,
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[
        dayjs().format('DD/MM/YYYY'), // Data contato
        dados.nome,                   // Nome
        dados.telefone,               // Telefone
        'AGENDADO',                   // Status
        dados.data,                   // Data consulta
        dados.horario,                // Horário
        'Bot WhatsApp',               // Obs
        local.nome,                   // Lugar
        '', '', '', '', '', '',
      ]],
    },
  });
}

// ── PROCESSAR MENSAGEM COM CLAUDE ─────────────────────────
async function processarMensagem(telefone, textoUsuario) {
  // Inicializa histórico se necessário
  if (!historicos[telefone]) historicos[telefone] = [];

  // Adiciona mensagem do usuário ao histórico
  historicos[telefone].push({ role: 'user', content: textoUsuario });

  // Limita histórico a 20 mensagens para não explodir o contexto
  if (historicos[telefone].length > 20) {
    historicos[telefone] = historicos[telefone].slice(-20);
  }

  try {
    // Chama o Claude
    const response = await claude.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system:     SYSTEM_PROMPT,
      messages:   historicos[telefone],
    });

    const resposta = response.content[0].text.trim();

    // Verifica se o Claude quer agendar (retornou o JSON especial)
    if (resposta.startsWith('AGENDAR:')) {
      const jsonStr = resposta.replace('AGENDAR:', '').trim();
      const dados   = JSON.parse(jsonStr);
      dados.telefone = telefone;

      // Adiciona resposta ao histórico
      historicos[telefone].push({ role: 'assistant', content: resposta });

      // Executa o agendamento
      await enviar(telefone, '⏳ Agendando sua consulta...');

      try {
        await Promise.all([
          criarEvento(dados),
          registrarPlanilha(dados),
        ]);

        const local = LOCAIS[dados.local.toLowerCase()] || LOCAIS['online'];

        // Limpa histórico após agendar
        delete historicos[telefone];

        await enviar(telefone,
          `✅ *Consulta agendada com sucesso!*\n\n` +
          `👤 *Paciente:* ${dados.nome}\n` +
          `📅 *Data:* ${dados.data}\n` +
          `🕐 *Horário:* ${dados.horario}\n` +
          `📍 *Local:* ${local.nome}\n` +
          `📌 *Endereço:* ${local.endereco}\n\n` +
          `Em caso de dúvidas ou reagendamento, entre em contato.\n\n` +
          `_Victor Afonso — Nutricionista_ 🥗`
        );

      } catch (e) {
        console.error('Erro ao agendar:', e);
        delete historicos[telefone];
        await enviar(telefone,
          '😕 Houve um problema ao confirmar o agendamento. Por favor, entre em contato diretamente.'
        );
      }

    } else {
      // Resposta normal de conversa
      historicos[telefone].push({ role: 'assistant', content: resposta });
      await enviar(telefone, resposta);
    }

  } catch (e) {
    console.error('Erro no Claude:', e.message);
    await enviar(telefone, 'Desculpe, tive um problema técnico. Por favor, tente novamente em instantes.');
  }
}

// ── WEBHOOK ───────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body  = req.body;
    const event = body.event || body.type;
    if (!event || (!event.includes('messages') && !event.includes('MESSAGES'))) return;

    const data = body.data || body;
    const msg  = data.message || data.messages?.[0];
    if (!msg) return;

    // Ignora mensagens próprias e de grupos
    if (msg.key?.fromMe)                         return;
    if (msg.key?.remoteJid?.includes('@g.us'))   return;

    const telefone = msg.key?.remoteJid?.replace('@s.whatsapp.net', '');
    const texto    = msg.message?.conversation
                  || msg.message?.extendedTextMessage?.text
                  || '';

    if (!telefone || !texto?.trim()) return;

    console.log(`[${dayjs().format('DD/MM HH:mm')}] ${telefone}: ${texto}`);
    await processarMensagem(telefone, texto);

  } catch (e) {
    console.error('Erro no webhook:', e);
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Bot Victor Afonso rodando! 🥗', timestamp: new Date().toISOString() });
});

// ── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot rodando na porta ${PORT}`));
