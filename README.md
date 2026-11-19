# Vinheria Agnello - Fase 7 (FIAP 3SOA)

Simulacao de parte da arquitetura de microsservicos da Vinheria Agnello com
**Docker**, **DNS/DHCP**, **pipeline Jenkins** e **comunicacao segura (JWT + HTTPS)**.

Equipe NVJP-Tech: Jean Matheus, Vinicius Wince, Nicolly Ramalho e Pedro Gustavo.

## Arquitetura

```
 PC (127.0.0.1)                     Rede Docker agnello-net (172.28.0.0/24)
 ----------------      +-----------------------------------------------------+
 https://:8443  --->   | proxy   172.28.0.30  (nginx, TLS)                   |
 http://:8081          |   |--> auth      172.28.0.10:8081  (login, JWT)     |
 http://:8082          |   |--> pedidos   172.28.0.11:8082  (pedidos)        |
 http://:8083          |   |--> estoque   172.28.0.12:8083  (saldo/reservas) |
 http://:8080          | dns     172.28.0.2   (dnsmasq: DNS + DHCP simulado)|
                       | jenkins 172.28.0.20:8080 (CI/CD)                    |
                       +-----------------------------------------------------+
```

| Servico | Nome interno | IP | Porta | Funcao |
|---|---|---|---|---|
| dns | dns.agnello.local | 172.28.0.2 | 53 | DNS interno e DHCP simulado (dnsmasq) |
| auth | auth.agnello.local | 172.28.0.10 | 8081 | Login e validacao de JWT |
| pedidos | pedidos.agnello.local | 172.28.0.11 | 8082 | Criacao, consulta e cancelamento de pedidos |
| estoque | estoque.agnello.local | 172.28.0.12 | 8083 | Saldo e reservas de vinhos |
| jenkins | jenkins.agnello.local | 172.28.0.20 | 8080 | Pipeline de build, teste e deploy |
| proxy | proxy.agnello.local | 172.28.0.30 | 443 / 80 | Proxy reverso com TLS (HTTPS) |

Todas as portas sao publicadas **somente em 127.0.0.1** (nada fica exposto na rede local).
Os nomes `*.agnello.local` so resolvem **dentro** da rede Docker.

## Estrutura do repositorio

```
auth/auth-service/        servico de autenticacao (Node.js + Express)
service/estoque-service/  servico de estoque
service/pedidos-service/  servico de pedidos
infra/dns/                Dockerfile e dnsmasq.conf
infra/jenkins/            Dockerfile do Jenkins (com Node.js)
infra/proxy/              nginx.conf (TLS)
infra/tls/                certificado e chave (NAO versionados)
deploy/                   pasta de publicacao do pipeline (conteudo ignorado pelo Git)
docs/                     evidencias e colecao do Postman
Jenkinsfile               pipeline declarativo
docker-compose.yml        orquestracao de todos os containers
.env.example              modelo das variaveis (o .env real NAO e versionado)
```

## Pre-requisitos

- Docker Desktop com Docker Compose
- Git
- Postman (para os testes)
- Wireshark (apenas para a captura HTTP x HTTPS)

## Como subir

1. Clone o repositorio e crie o `.env` a partir do modelo:

   ```
   copy .env.example .env
   ```

   Edite o `.env` e defina `JWT_SECRET` (minimo 32 caracteres) e as credenciais
   de laboratorio dos dois usuarios (cliente e atendente). **Nunca** faca commit do `.env`.

2. Gere o certificado autoassinado do proxy (PowerShell, na raiz do projeto):

   ```
   docker run --rm -v "${PWD}/infra/tls:/tls" alpine/openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout /tls/proxy.key -out /tls/proxy.crt -subj "/CN=proxy.agnello.local" -addext "subjectAltName=DNS:proxy.agnello.local,DNS:localhost,IP:127.0.0.1"
   ```

3. Suba tudo:

   ```
   docker compose up -d --build
   docker ps
   ```

   Todos os containers devem ficar `healthy`.

## Testes rapidos

```
curl.exe http://localhost:8081/health
curl.exe http://localhost:8088/proxy-health
curl.exe -k https://localhost:8443/auth/health
```

No Postman (para HTTPS, desligue *SSL certificate verification*, pois o certificado e autoassinado):

| Chamada | Quem | Esperado |
|---|---|---|
| `POST /auth/login` (usuario e senha do `.env`) | cliente ou atendente | 200 com token |
| `POST /pedidos` `{ "vinhoId": "malbec-2021", "quantidade": 2 }` | cliente | 201 `CONFIRMADO` |
| `POST /pedidos` com quantidade acima do saldo | cliente | 409 `REJEITADO` |
| `GET /pedidos/{id}` | dono ou atendente | 200 |
| `GET /pedidos/{id}` | outro cliente | 403 |
| `PATCH /pedidos/{id}/cancelar` | cliente | 403 |
| `PATCH /pedidos/{id}/cancelar` | atendente | 200 `CANCELADO` |
| qualquer rota sem token | - | 401 |
| `docker stop agnello-auth` e `POST /pedidos` | cliente | 503 |

Vinhos de exemplo (em memoria): `malbec-2021` (saldo 10), `cabernet-2020` (5) e `merlot-2022` (0).

## Pipeline Jenkins

1. Painel em `http://localhost:8080`. A senha inicial esta em
   `docker exec agnello-jenkins cat /var/jenkins_home/secrets/initialAdminPassword`.
2. Crie um job **Pipeline** com *Pipeline script from SCM*, Git, a URL deste repositorio
   (publico, sem credencial) e Script Path `Jenkinsfile`.
3. Etapas: **Checkout, Ferramentas, Build** (`npm ci`), **Teste** (sintaxe e `/health` de cada servico)
   e **Deploy** (copia para `deploy/current` e grava o `MANIFESTO.txt`).

## Seguranca (DevSecOps)

- **Autenticacao:** JWT (HS256, emissor `agnello-auth`, expiracao de 15 min). Cada servico valida o token
  chamando o Auth em **toda** requisicao (Auth fora do ar = 503).
- **Autorizacao:** papeis `cliente` e `atendente` (RBAC), negando por padrao. Codigos 401, 403, 409, 413, 429 e 503.
- **Anti forca bruta:** o login bloqueia apos 5 falhas em 60 s (429); o proxy limita 10 requisicoes/s por IP.
- **Containers:** `USER node`, `cap_drop: ALL`, `no-new-privileges`, `read_only` e `tmpfs`; imagens com versao fixa.
- **Segredos:** `.env`, chaves e certificados fora do Git (`.gitignore`); o Jenkins nao monta o `docker.sock`.
- **Transporte:** HTTPS (TLS 1.2/1.3) no proxy. Para comparar HTTP x HTTPS no Wireshark:

  ```
  docker run --rm --net container:agnello-auth  -v "${PWD}/docs:/out" nicolaka/netshoot tcpdump -i eth0 -w /out/captura-http.pcap port 8081
  docker run --rm --net container:agnello-proxy -v "${PWD}/docs:/out" nicolaka/netshoot tcpdump -i eth0 -w /out/captura-https.pcap port 443
  ```

  Os arquivos `.pcap` ficam fora do Git (contem credenciais de laboratorio).

## Limitacoes assumidas (simulacao academica)

- O **DHCP e simulado**: o Docker atribui os IPs; o dnsmasq demonstra o conceito.
- Os dados ficam **em memoria** (simula o *Database per Service*); nao ha banco real.
- Nao ha o servico de Pagamentos: a Saga foi reduzida a Pedidos -> Estoque (reserva).
- Credenciais de laboratorio em `.env`; certificado **autoassinado**.
- O TLS termina no proxy; o trecho proxy -> servicos segue em HTTP dentro da rede Docker.
- O Jenkins consulta o Git a cada ~5 min (sem webhook) e o deploy e uma copia de arquivos para `deploy/current`.
