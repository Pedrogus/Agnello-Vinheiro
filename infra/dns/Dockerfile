# Imagem base: Alpine (pequena). A versao e FIXA de proposito:
# o build de hoje fica igual ao de amanha (reprodutibilidade).
# Evite "latest".

FROM alpine:3.20
RUN apk add --no-cache dnsmasq

# Copia a configuracao do repositorio para dentro da imagem.
# O arquivo dnsmasq.conf precisa estar na mesma pasta deste Dockerfile.
COPY dnsmasq.conf /etc/dnsmasq.conf

# Portas usadas (documentacao; NAO publica nada para o seu PC):
#   53/tcp e 53/udp = DNS
#   67/udp          = DHCP
EXPOSE 53/tcp 53/udp 67/udp
 
# Sobe o dnsmasq lendo o arquivo acima.
# O "keep-in-foreground" ja esta dentro do dnsmasq.conf,
# entao o processo fica na frente e o container nao encerra.
CMD ["dnsmasq", "--conf-file=/etc/dnsmasq.conf"]
