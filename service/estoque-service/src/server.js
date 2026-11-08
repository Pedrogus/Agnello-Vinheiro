'user strict'

const crypto = require('node:crypto');
const express = require('express');

function falhar(mensagem) {
  console.error(`[estoque] ERRO DE CONFIGURACAO: ${mensagem}`);
  process.exit(1);
}

function lerConfiguracao() {
    const authBruta = process.env.AUTH_URL;
    if (!authBruta) falhar('AUTH_URL ausente (ex.: http://auth.agnello.local:8081).');

    let authUrl;
  try {
    authUrl = new URL(authBruta);
  } catch {
    return falhar('AUTH_URL invalida.');
  }
  if (authUrl.protocol !== 'http:' && authUrl.protocol !== 'https:') {
    falhar('AUTH_URL precisa comecar com http:// ou https://.');
  }
 
  const porta = Number(process.env.PORT || '8083');
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) {
    falhar('PORT invalida.');
  }

    const tempoAuthMs = Number(process.env.AUTH_TIMEOUT_MS || '2000');
  if (!Number.isInteger(tempoAuthMs) || tempoAuthMs < 100 || tempoAuthMs > 10000) {
    falhar('AUTH_TIMEOUT_MS deve ser um inteiro entre 100 e 10000.');
  }
 
  return {
    porta,
    tempoAuthMs,
    // Usa so a origem (protocolo + host + porta): ignora caminho extra.
    validateUrl: `${authUrl.origin}/validate`,
  };

}

const config = lerConfiguracao();

// Tres vinhos de exemplo, de proposito: caso normal, caso para estourar

const vinhos = new Map([
  ['malbec-2021',   { nome: 'Malbec Reserva 2021',     saldo: 10 }],
  ['cabernet-2020', { nome: 'Cabernet Sauvignon 2020', saldo: 5 }],
  ['merlot-2022',   { nome: 'Merlot 2022',             saldo: 0 }],
]);

const reservas = new Map();
 
// Soma das quantidades reservadas de um vinho.
function totalReservado(vinhoId) {
  let total = 0;
  for (const reserva of reservas.values()) {
    if (reserva.vinhoId === vinhoId) total += reserva.quantidade;
  }
  return total;
}
 
// Disponivel = saldo - reservas ativas.
function calcularDisponivel(vinhoId) {
  return vinhos.get(vinhoId).saldo - totalReservado(vinhoId);
}


// Filtro 1: AUTENTICAR. Pergunta ao auth-service quem esta chamando.
async function autenticar(req, res, next) {
  const cabecalho = req.get('authorization');
 
  // Sem cabecalho: 401 direto, sem nem incomodar o Auth.
  if (!cabecalho) {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ erro: 'Token ausente.' });
  }
 
  let resposta;
  try {
    // Repassa o MESMO cabecalho Authorization e nao espera para sempre.
    resposta = await fetch(config.validateUrl, {
      method: 'GET',
      headers: { authorization: cabecalho },
      signal: AbortSignal.timeout(config.tempoAuthMs),
    });
  } catch (erro) {
    // Auth fora do ar, DNS falhou ou estourou o tempo limite.
    console.error(`[estoque] auth indisponivel (${erro.name})`);
    return res.status(503).json({ erro: 'Servico de autenticacao indisponivel.' });
  }
 
  if (resposta.status === 401) {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ erro: 'Token invalido ou expirado.' });
  }
 
  if (!resposta.ok) {
    return res.status(503).json({ erro: 'Servico de autenticacao indisponivel.' });
  }
 
  let dados;
  try {
    dados = await resposta.json();
  } catch {
    return res.status(503).json({ erro: 'Resposta invalida do servico de autenticacao.' });
  }
 
  // Confere o formato da resposta antes de confiar nela.
  if (!dados || dados.valido !== true ||
      typeof dados.usuario !== 'string' || typeof dados.papel !== 'string') {
    return res.status(503).json({ erro: 'Resposta invalida do servico de autenticacao.' });
  }
 
  req.usuario = { usuario: dados.usuario, papel: dados.papel };
  return next();
}
 
// Filtro 2: EXIGIR PAPEL. Negar por padrao: so passa quem esta na lista.
function exigirPapel(...permitidos) {
  return (req, res, next) => {
    if (!req.usuario || !permitidos.includes(req.usuario.papel)) {
      return res.status(403).json({ erro: 'Acesso negado para o seu papel.' });
    }
    return next();
  };
}


// APLICACAO EXPRESS
const app = express();
 
app.disable('x-powered-by');
app.use(express.json({ limit: '1kb' }));
 
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});


// GET /health - sem filtros (Docker e Jenkins precisam chamar sem token)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', servico: 'estoque-service' });
});
 
// GET /estoque/:vinhoId - so atendente
app.get('/estoque/:vinhoId', autenticar, exigirPapel('atendente'), (req, res) => {
  const { vinhoId } = req.params;
  const vinho = vinhos.get(vinhoId);
 
  if (!vinho) {
    return res.status(404).json({ erro: 'Vinho nao encontrado.' });
  }
 
  return res.json({
    vinho_id: vinhoId,
    nome: vinho.nome,
    saldo: vinho.saldo,
    reservado: totalReservado(vinhoId),
    disponivel: calcularDisponivel(vinhoId),
  });
});
 
// POST /estoque/reservas - cliente e atendente
// Corpo: { "vinhoId": "malbec-2021", "quantidade": 3 }
app.post('/estoque/reservas', autenticar, exigirPapel('cliente', 'atendente'), (req, res) => {
  const { vinhoId, quantidade } = req.body ?? {};
 
  // Valida tipo e faixa ANTES de qualquer regra de negocio.
  const entradaValida =
    typeof vinhoId === 'string' && vinhoId.length > 0 && vinhoId.length <= 64 &&
    Number.isInteger(quantidade) && quantidade >= 1 && quantidade <= 100;
 
  if (!entradaValida) {
    return res.status(400).json({
      erro: 'Informe vinhoId (texto) e quantidade (inteiro de 1 a 100).',
    });
  }
 
  const vinho = vinhos.get(vinhoId);
  if (!vinho) {
    return res.status(404).json({ erro: 'Vinho nao encontrado.' });
  }
 
  // Checagem e gravacao no mesmo trecho sincrono: o Node nao intercala
  // outra requisicao aqui no meio, entao nao ha corrida entre reservas.
  const disponivel = calcularDisponivel(vinhoId);
  if (quantidade > disponivel) {
    // De proposito NAO informa o saldo: quem nao pode consultar o
    // estoque (cliente) tambem nao deve descobri-lo pelo erro.
    return res.status(409).json({ erro: 'Estoque insuficiente.' });
  }
 
  const id = crypto.randomUUID();
  reservas.set(id, {
    id,
    vinhoId,
    quantidade,
    usuario: req.usuario.usuario,
    criada_em: new Date().toISOString(),
  });
 
  console.log(`[estoque] reserva criada (vinho=${vinhoId}, quantidade=${quantidade})`);
  return res.status(201).json({
    reserva_id: id,
    vinho_id: vinhoId,
    quantidade,
  });
});
 
// DELETE /estoque/reservas/:id - so atendente (compensacao da Saga)
app.delete('/estoque/reservas/:id', autenticar, exigirPapel('atendente'), (req, res) => {
  const { id } = req.params;
 
  if (!reservas.has(id)) {
    return res.status(404).json({ erro: 'Reserva nao encontrada.' });
  }
 
  reservas.delete(id);
  console.log('[estoque] reserva liberada');
  return res.status(204).end();
});

// ERROS E ROTAS INEXISTENTES (sempre em JSON)

app.use((req, res) => {
  res.status(404).json({ erro: 'Rota nao encontrada.' });
});
 
// Express reconhece o tratador de erros pelos 4 parametros.
// eslint-disable-next-line no-unused-vars
app.use((erro, req, res, next) => {
  if (erro.type === 'entity.too.large') {
    return res.status(413).json({ erro: 'Corpo da requisicao grande demais.' });
  }
  if (erro.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'JSON invalido.' });
  }
  console.error('[estoque] erro inesperado:', erro.message);
  return res.status(500).json({ erro: 'Erro interno.' });
});

//  INICIALIZACAO E ENCERRAMENTO LIMPO

const servidor = app.listen(config.porta, '0.0.0.0', () => {
  console.log(`[estoque] ouvindo na porta ${config.porta} (auth: ${config.validateUrl})`);
});
 
// "docker stop" envia SIGTERM: fecha as conexoes e encerra sem cortar ninguem.
function encerrar() {
  console.log('[estoque] encerrando...');
  servidor.close(() => process.exit(0));
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);
