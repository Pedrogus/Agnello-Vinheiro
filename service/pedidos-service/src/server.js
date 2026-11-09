'use strict';

// =====================================================================
// Vinheria Agnello - pedidos-service 
// Local no repositorio: service/pedidos-service/src/server.js
// Rotas: POST /pedidos, GET /pedidos/:id, PATCH /pedidos/:id/cancelar
// e GET /health. Autentica no Auth e reserva/libera itens no Estoque.
// =====================================================================

const crypto = require('node:crypto');
const express = require('express');

// ---------------------------------------------------------------------
// BLOCO 1 - CONFIGURACAO (falha rapido se algo estiver errado)
// ---------------------------------------------------------------------
function falhar(mensagem) {
  console.error(`[pedidos] ERRO DE CONFIGURACAO: ${mensagem}`);
  process.exit(1);
}

// Le uma URL do ambiente e devolve so a origem (protocolo + host + porta).
function lerUrl(nome, exemplo) {
  const bruta = process.env[nome];
  if (!bruta) falhar(`${nome} ausente (ex.: ${exemplo}).`);

  let url;
  try {
    url = new URL(bruta);
  } catch {
    return falhar(`${nome} invalida.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    falhar(`${nome} precisa comecar com http:// ou https://.`);
  }
  return url.origin;
}

function lerConfiguracao() {
  const porta = Number(process.env.PORT || '8082');
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) {
    falhar('PORT invalida.');
  }

  // Tempo maximo de espera ao chamar outro servico (Auth/Estoque).
  const tempoChamadaMs = Number(process.env.CHAMADA_TIMEOUT_MS || '2000');
  if (!Number.isInteger(tempoChamadaMs) || tempoChamadaMs < 100 || tempoChamadaMs > 10000) {
    falhar('CHAMADA_TIMEOUT_MS deve ser um inteiro entre 100 e 10000.');
  }

  const authOrigem = lerUrl('AUTH_URL', 'http://auth.agnello.local:8081');
  const estoqueOrigem = lerUrl('ESTOQUE_URL', 'http://estoque.agnello.local:8083');

  return {
    porta,
    tempoChamadaMs,
    validateUrl: `${authOrigem}/validate`,
    estoqueUrl: estoqueOrigem,
  };
}

const config = lerConfiguracao();

// ---------------------------------------------------------------------
// BLOCO 1B - DADOS EM MEMORIA (simula o banco do Pedidos)
// ---------------------------------------------------------------------
// Database per Service: so o Pedidos mexe nestes dados.
// Status possiveis: CONFIRMADO, REJEITADO, CANCELANDO (transitorio), CANCELADO.
const pedidos = new Map();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------
// BLOCO 1C - FILTROS DE SEGURANCA
// ---------------------------------------------------------------------
// Filtro 1: AUTENTICAR. Pergunta ao auth-service quem esta chamando.
async function autenticar(req, res, next) {
  const cabecalho = req.get('authorization');

  // Sem cabecalho: 401 direto, sem incomodar o Auth.
  if (!cabecalho) {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ erro: 'Token ausente.' });
  }

  let resposta;
  try {
    resposta = await fetch(config.validateUrl, {
      method: 'GET',
      headers: { authorization: cabecalho },
      signal: AbortSignal.timeout(config.tempoChamadaMs),
    });
  } catch (erro) {
    console.error(`[pedidos] auth indisponivel (${erro.name})`);
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

  if (!dados || dados.valido !== true ||
      typeof dados.usuario !== 'string' || typeof dados.papel !== 'string') {
    return res.status(503).json({ erro: 'Resposta invalida do servico de autenticacao.' });
  }

  req.usuario = { usuario: dados.usuario, papel: dados.papel };
  // Guarda o cabecalho para repassar o MESMO token ao Estoque.
  req.autorizacao = cabecalho;
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

// Chamada ao Estoque com tempo limite. Repassa o token do usuario.
function chamarEstoque(caminho, metodo, autorizacao, corpo) {
  const opcoes = {
    method: metodo,
    headers: { authorization: autorizacao },
    signal: AbortSignal.timeout(config.tempoChamadaMs),
  };
  if (corpo !== undefined) {
    opcoes.headers['content-type'] = 'application/json';
    opcoes.body = JSON.stringify(corpo);
  }
  return fetch(`${config.estoqueUrl}${caminho}`, opcoes);
}

// Visao publica do pedido (nao expoe o id interno da reserva).
function visaoPedido(p) {
  return {
    id: p.id,
    vinho_id: p.vinhoId,
    quantidade: p.quantidade,
    usuario: p.usuario,
    status: p.status,
    criado_em: p.criado_em,
  };
}

// ---------------------------------------------------------------------
// BLOCO 2 - APLICACAO E PROTECOES BASICAS
// ---------------------------------------------------------------------
const app = express();

// Nao anuncia "X-Powered-By: Express" (menos pista para quem ataca).
app.disable('x-powered-by');

// Cabecalhos de seguranca simples em toda resposta.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'no-store');
  next();
});

// Limita o corpo JSON a 10 KB (acima disso: erro 413).
app.use(express.json({ limit: '10kb' }));

// ---------------------------------------------------------------------
// BLOCO 3 - ROTAS
// ---------------------------------------------------------------------
// GET /health - sem token (Docker e Jenkins chamam sem autenticar)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pedidos-service' });
});

// POST /pedidos - cliente e atendente
// Corpo: { "vinhoId": "malbec-2021", "quantidade": 2 }
// Saga reduzida: reserva no Estoque -> CONFIRMADO (409 -> REJEITADO).
app.post('/pedidos', autenticar, exigirPapel('cliente', 'atendente'), async (req, res) => {
  const { vinhoId, quantidade } = req.body ?? {};

  const entradaValida =
    typeof vinhoId === 'string' && vinhoId.length > 0 && vinhoId.length <= 64 &&
    Number.isInteger(quantidade) && quantidade >= 1 && quantidade <= 100;
  if (!entradaValida) {
    return res.status(400).json({
      erro: 'Informe vinhoId (texto) e quantidade (inteiro de 1 a 100).',
    });
  }

  let resposta;
  try {
    resposta = await chamarEstoque('/estoque/reservas', 'POST', req.autorizacao, { vinhoId, quantidade });
  } catch (erro) {
    console.error(`[pedidos] estoque indisponivel (${erro.name})`);
    return res.status(503).json({ erro: 'Servico de estoque indisponivel.' });
  }

  // Vinho inexistente: nao cria pedido nenhum.
  if (resposta.status === 404) {
    return res.status(404).json({ erro: 'Vinho nao encontrado.' });
  }

  const pedido = {
    id: crypto.randomUUID(),
    vinhoId,
    quantidade,
    usuario: req.usuario.usuario,
    status: 'REJEITADO',
    reservaId: null,
    criado_em: new Date().toISOString(),
  };

  if (resposta.status === 201) {
    let dados;
    try {
      dados = await resposta.json();
    } catch {
      dados = null;
    }
    if (!dados || typeof dados.reserva_id !== 'string') {
      return res.status(503).json({ erro: 'Resposta invalida do servico de estoque.' });
    }
    pedido.status = 'CONFIRMADO';
    pedido.reservaId = dados.reserva_id;
  } else if (resposta.status !== 409) {
    // Qualquer outra resposta (401, 403, 5xx...) e falha do Estoque, nao do cliente.
    console.error(`[pedidos] estoque respondeu ${resposta.status}`);
    return res.status(503).json({ erro: 'Servico de estoque indisponivel.' });
  }

  pedidos.set(pedido.id, pedido);
  console.log(`[pedidos] pedido ${pedido.status} (vinho=${vinhoId}, quantidade=${quantidade})`);
  // 201 se confirmado; 409 (estoque insuficiente) se rejeitado.
  return res.status(pedido.status === 'CONFIRMADO' ? 201 : 409).json(visaoPedido(pedido));
});

// GET /pedidos/:id - dono do pedido ou atendente
app.get('/pedidos/:id', autenticar, exigirPapel('cliente', 'atendente'), (req, res) => {
  const { id } = req.params;
  const pedido = UUID.test(id) ? pedidos.get(id) : undefined;
  if (!pedido) {
    return res.status(404).json({ erro: 'Pedido nao encontrado.' });
  }

  // Cliente so ve o proprio pedido; atendente ve todos.
  if (req.usuario.papel !== 'atendente' && pedido.usuario !== req.usuario.usuario) {
    return res.status(403).json({ erro: 'Acesso negado para este pedido.' });
  }
  return res.json(visaoPedido(pedido));
});

// PATCH /pedidos/:id/cancelar - so atendente (compensacao da Saga)
app.patch('/pedidos/:id/cancelar', autenticar, exigirPapel('atendente'), async (req, res) => {
  const { id } = req.params;
  const pedido = UUID.test(id) ? pedidos.get(id) : undefined;
  if (!pedido) {
    return res.status(404).json({ erro: 'Pedido nao encontrado.' });
  }
  if (pedido.status !== 'CONFIRMADO') {
    return res.status(409).json({ erro: `Pedido nao pode ser cancelado (status ${pedido.status}).` });
  }

  // Trava contra dois cancelamentos ao mesmo tempo.
  pedido.status = 'CANCELANDO';
  let resposta;
  try {
    resposta = await chamarEstoque(
      `/estoque/reservas/${encodeURIComponent(pedido.reservaId)}`,
      'DELETE',
      req.autorizacao
    );
  } catch (erro) {
    pedido.status = 'CONFIRMADO';
    console.error(`[pedidos] estoque indisponivel (${erro.name})`);
    return res.status(503).json({ erro: 'Servico de estoque indisponivel.' });
  }

  // 204 = liberada; 404 = reserva ja nao existia (tambem serve).
  if (resposta.status !== 204 && resposta.status !== 404) {
    pedido.status = 'CONFIRMADO';
    console.error(`[pedidos] estoque respondeu ${resposta.status} ao liberar`);
    return res.status(503).json({ erro: 'Nao foi possivel liberar a reserva no estoque.' });
  }

  pedido.status = 'CANCELADO';
  console.log('[pedidos] pedido cancelado');
  return res.json(visaoPedido(pedido));
});

// ---------------------------------------------------------------------
// BLOCO 4 - ERROS E ROTAS INEXISTENTES (sempre em JSON)
// ---------------------------------------------------------------------
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
  console.error('[pedidos] erro inesperado:', erro.message);
  return res.status(500).json({ erro: 'Erro interno.' });
});

// ---------------------------------------------------------------------
// BLOCO 5 - INICIALIZACAO E ENCERRAMENTO LIMPO
// ---------------------------------------------------------------------
const servidor = app.listen(config.porta, '0.0.0.0', () => {
  console.log(
    `[pedidos] ouvindo na porta ${config.porta} (auth: ${config.validateUrl}, estoque: ${config.estoqueUrl})`
  );
});

// "docker stop" envia SIGTERM: fecha as conexoes e encerra sem cortar ninguem.
function encerrar() {
  console.log('[pedidos] encerrando...');
  servidor.close(() => process.exit(0));
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);
