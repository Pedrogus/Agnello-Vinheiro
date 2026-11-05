'use strict';

// Vinheria Agnello - auth-service

// Rotas:
//   POST /login     -> confere usuario/senha e devolve um token JWT
//   GET  /validate  -> confere o token e devolve usuario e papel
//   GET  /health    -> saude do servico (Docker/Jenkins)

const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

function falhar(mensagem) {
    console.error(`[auth] ERRO DE CONFIGURACAO: ${mensagem}`);
    process.exit(1);
}

function lerConfiguracao() {
    const faltando = [];
    const exigir = (nome) => {
        const valor = process.env[nome];
        if(!valor) faltando.push(nome);
        return valor;
    };

    const segredo = exigir('JWT_SECRET')
    const clienteUsuario = exigir('CLIENTE_USUARIO');
    const clienteSenha = exigir('CLIENTE_SENHA');
    const atendenteUsuario = exigir('ATENDENTE_USUARIO');
    const atendenteSenha = exigir('ATENDENTE_SENHA');

    if(faltando.length > 0) {
        falhar(`Variaveis de ambiente ausentes: ${faltando.join(', ')}`);
    }

    if(segredo.length < 32) {
        falhar('JWT_SECRET deve ter pelo menos 32 caracteres');
    }


    if(clienteUsuario === atendenteUsuario) {
        falhar('CLIENTE_USUARIO e ATENDENTE_USUARIO devem ser diferentes');
    }


    const minutos = Number(process.env.JWT_EXPIRACAO_MINUTOS || 15);
        if(!Number.isInteger(minutos) || minutos < 1 || minutos > 1440) {
            falhar('JWT_EXPIRACAO_MINUTOS deve ser um inteiro entre 1 e 1440');
        }

        const porta = Number(process.env.PORT || 3000);
        if(!Number.isInteger(porta) || porta < 1 || porta > 65535) {
            falhar('PORT invalida.');
        }

        return {
            segredo,
            minutos,
            porta,
            usuarios: [
                { usuario: clienteUsuario, senha: clienteSenha, papel: 'cliente' },
                { usuario: atendenteUsuario, senha: atendenteSenha, papel: 'atendente' },
            ],
        };
}

const config = lerConfiguracao();

const EMISSOR = 'agnello-auth';
const ALGORITMO = 'HS256';
const PAPEIS_VALIDOS = new Set(config.usuarios.map((u) => u.papel));

function igual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function autenticar(usuario, senha) {
    let encontrado = null;
    for(const candidato of config.usuarios) {
        const usuarioOk = igual(usuario, candidato.usuario);
        const senhaOk = igual(senha, candidato.senha);
        if(usuarioOk && senhaOk) {
            encontrado = candidato;
        }
    }
    return encontrado;
}

const JANELA_MMS = 60_000;
const MAX_FALHAS = 5;
const falhasPorIp = new Map();

function bloquado(ip) {
    const registro = falhasPorIp.get(ip);
    if(!registro) return false;
    if(Date.now() > registro.expira) {
        falhasPorIp.delete(ip);
        return false;
    }
    return registro.contagem >= MAX_FALHAS;
}

function registrarFalha(ip) {
    const agora = Date.now();
    let registro = falhasPorIp.get(ip);
    if(!registro || agora > registro.expira) {
        falhasPorIp.set(ip, { contagem: 1, expira: agora + JANELA_MMS });
    } else {
        registro.contagem++;
    }
}

setInterval(() => {
    const agora = Date.now();
    for(const [ip, registro] of falhasPorIp) {
        if(agora > registro.expira) falhasPorIp.delete(ip);
        }
    }, JANELA_MMS).unref();


const app = express();

app.disable('x-powered-by');
app.use(express.json({limit: '1kb'}));

app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

//ROTAS
app.post('/login', (req, res) => {
    const ip = req.ip;

    if(bloquado(ip)) {
        res.set('Retry-After', String(JANELA_MMS / 1000));
        return res.status(429).json({ erro: 'Muitas tentativas. Tente novamente mais tarde.' });
    }

    const { usuario, senha } = req.body ?? {};

    const entradaValida =
        typeof usuario === 'string' && typeof senha === 'string' 
        &&
        usuario.length > 0 && senha.length > 0 &&
        usuario.length <= 128 && senha.length <= 128;

        if(!entradaValida) {
            return res.status(400).json({erro: 'Informe usuario e senha.'});
        }

        const encontrado = autenticar(usuario, senha);
        if(!encontrado) {
                registrarFalha(ip);
              console.log('[auth] login recusado');
            return res.status(401).json({erro: 'Usuario ou senha invalidos.'});
        }

        falhasPorIp.delete(ip);

        const token = jwt.sign(
            {papel: encontrado.papel}, config.segredo, {
                algorithm: ALGORITMO,
                subject: encontrado.usuario,
                expiresIn: `${config.minutos}m`,
                issuer: EMISSOR
            }
        );


        console.log(`[auth] login bem-sucedido para papel: ${encontrado.papel}`);
            return res.json({token, tipo: 'Bearer', expiraEm: config.minutos * 60});

});

app.get('/validate', (req, res) => {
 const naoAutorizado = () => {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({valido: false, erro: 'Token ausente, invalido ou expirado'});

 };

    const cabecalho = req.get('authorization') || '';
    const [esquema, token] = cabecalho.split(' ');
    if(esquema !== 'Bearer' || !token) return naoAutorizado();

     try {
        const dados = jwt.verify(token, config.segredo, {
            algorithms: [ALGORITMO],
            issuer: EMISSOR,
        });

        if (!PAPEIS_VALIDOS.has(dados.papel)) return naoAutorizado();

            return res.json({
                valido: true,
                usuario: dados.sub,
                papel: dados.papel,
                expira_em: dados.exp,
            });
     } catch {
        return naoAutorizado();
     }

});

app.get('/health', (req, res) => {
    res.json({status: 'ok', service: 'auth-service'});
});

app.use((req, res) => {
    res.status(404).json({erro: 'Rota não encontrada'});
});

app.use((erro, req, res, next) => {
  if (erro.type === 'entity.too.large') {
    return res.status(413).json({ erro: 'Corpo da requisição grande demais.' });
  }
  if (erro.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'JSON inválido.' });
  }
  console.error('[auth] erro inesperado:', erro.message);
  return res.status(500).json({ erro: 'Erro interno.' });
});


const servidor = app.listen(config.porta, '0.0.0.0', () => {
  console.log(`[auth] ouvindo na porta ${config.porta} (token expira em ${config.minutos} min)`);
});

function encerrar() {
  console.log('[auth] encerrando...');
  servidor.close(() => process.exit(0));
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);



