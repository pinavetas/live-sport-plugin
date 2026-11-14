# Plooplayer — listas W3U en Stremio / Nuvio

Provider que recibe la URL de una lista de **Plooplayer** (formato W3U con campos cifrados) y
muestra sus canales en Stremio y Nuvio **con la misma agrupación que la app**. La lista no
está fija en el código: se pone en `/configure` y, si cambia, se pega la nueva y se reinstala.

## Cómo se ve

| App Plooplayer | Stremio / Nuvio |
|---|---|
| Grupo de primer nivel ("Eventos Deportivos HD+") | Una fila (catálogo) del tipo `Plooplayer` |
| Subgrupos ("Opcion 1 ✅ (ON)", "Opcion 1 › BALONCESTO") | Filtro de género de esa fila; cada nivel intermedio también filtra |
| Variantes del mismo canal ("DAZN 1 720p *", "DAZN 1 1080p **", "… (servidor paz)") | Un solo canal con un stream por variante |
| Páginas web (`embed`: Telegram, webs de eventos) | No se muestran |

Los IDs (filas, filtros y canales) ignoran emojis y "(ON)/(OFF)": si un grupo cambia de
"✅ (ON)" a "❌ (OFF)", nada se rompe. El manifest guarda los nombres de los filtros al
instalar; si la lista **renombra** grupos, reinstala para ver los nombres nuevos (los
canales siempre salen actualizados, la lista se recarga cada 10 min).

## Tipos de canal y cómo se reproducen

| Tipo en la lista | Stream que devuelve el addon |
|---|---|
| DASH + ClearKey (`qqs.qs`) | `http://<descifrador>/ploo/index.m3u8?d=…` → **descifrador local** |
| HLS / directo | URL directa; cabeceras como `behaviorHints.proxyHeaders` |
| `acestream://` | `externalUrl` (abre la app Ace Stream si está instalada) |

**Ni Stremio ni Nuvio pueden descifrar ClearKey.** Descifrar en el servidor movería todo el
vídeo por Vercel (≈3,7 GB por hora a 1080p, cupo Hobby de 10 GB/mes, y al agotarse se pausa
el proyecto entero), así que el descifrado se hace **en el dispositivo del espectador**. El
addon solo entrega URLs (I1/I8 intactos).

## El descifrador local

Un script Node sin dependencias (`src/services/plooplayer/localDecryptor.js`) que convierte el
DASH cifrado en HLS en claro. Reutiliza `DashToHlsService` y `cenc/*`, lo mismo que se validó
contra emisiones reales. El addon lo sirve como un único fichero en `GET /plooplayer/decryptor.js`.

### Android TV / Google TV / Fire TV (Termux)

1. Instala **Termux** desde F-Droid o GitHub (la versión de Play Store está abandonada).
2. En Termux:
   ```sh
   pkg update && pkg install nodejs-lts
   curl -fsSL https://<tu-addon>/plooplayer/decryptor.js -o ~/ploo-decryptor.js
   node ~/ploo-decryptor.js
   ```
3. En `/configure` → *Plooplayer*: pon la URL de la lista y `http://127.0.0.1:8090` como
   descifrador, e instala.

Arranque automático con **Termux:Boot** (instálalo también y ábrelo una vez):

```sh
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/ploo-decryptor.sh <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
node ~/ploo-decryptor.js >> ~/ploo-decryptor.log 2>&1
EOF
chmod +x ~/.termux/boot/ploo-decryptor.sh
```

Consejo: escribir en la tele es incómodo. Con `pkg install openssh && passwd && sshd` puedes
entrar desde el PC con `ssh -p 8022 <ip-de-la-tele>`.

Para actualizar el descifrador, vuelve a ejecutar el `curl` (la versión sale en `/health`).

### Otro equipo de casa (PC, NAS, Raspberry Pi)

```sh
HOST=0.0.0.0 PORT=8090 node ploo-decryptor.js
```

y en `/configure` usa `http://<ip-del-equipo>:8090`. También sirve desde el código fuente:
`node src/services/plooplayer/localDecryptorCli.js`.

### Endpoints

| Ruta | Respuesta |
|---|---|
| `GET /health` | `{ ok, name, version }` |
| `GET /ploo/index.m3u8?d=` | HLS master (todas las calidades) |
| `GET /ploo/video.m3u8` · `/ploo/audio.m3u8` | playlists de vídeo y audio |
| `GET /ploo/init.mp4` · `/ploo/segment.mp4` | init sin cajas de protección / segmento descifrado |

`d` lo genera el addon (`PlooDecryptorToken`): URL del MPD, mapa `kid → key` y cabeceras
permitidas (Referer, Origin, User-Agent). No va firmado: el descifrador escucha en tu red y las
claves son las que publica la propia lista. Rechaza hosts privados (SSRF) y cabeceras no
permitidas.

## Formato W3U (verificado en listas reales, 2026-11-14)

| Campo | Significado |
|---|---|
| `ploorl` | URL cifrada: stream en estaciones, sublista en grupos |
| `ploore` / `ploori` / `ploousag` | Referer / Origin / User-Agent cifrados (en claro: `referer`, `origin`, `userAgent`) |
| `qqs.qs[]` | pares `kidHex:keyHex` cifrados; hasta 4 por canal (vídeo y audio con KID distintos) |
| `embed: "true"` | página web, no stream |
| `p` + `info: "… (Mira 2 anuncios)"` | muro de anuncios de la app; sin datos |
| `pl` | versión mínima de la app (cifrada) |
| `import: true` | la sublista se inyecta en ese nivel |

Cifrado de todos los campos: `base64(iv8 ‖ ChaCha20-BC(base64(AES-128-CBC(texto))))`. La
ChaCha20 es la de BouncyCastle con clave de 16 bytes, que Node/OpenSSL no implementan:
`PlooCrypto.js` la trae escrita a mano. Hay un vector conocido en `tests/plooplayerCrypto.test.js`.

## Código

| Fichero | Papel |
|---|---|
| `src/providers/PlooplayerProvider.js` | descarga la lista y sublistas (`proxyFetch`, I10); hoja, sin caché (I3) |
| `src/services/plooplayer/PlooCrypto.js` | ChaCha20-BC + AES |
| `src/services/plooplayer/PlooListParser.js` | W3U → árbol normalizado (tipos, claves, cabeceras) |
| `src/services/plooplayer/PlooChannels.js` | árbol → filas, filtros y canales con variantes |
| `src/services/PlooplayerService.js` | caché por lista (10 min, sirve copia caducada hasta 6 h si la lista cae), catálogos, meta y streams |
| `src/routes/plooplayer.js` | rutas catalog/meta/stream del tipo `Plooplayer` (antes del SDK) y `/plooplayer/decryptor.js` |
| `src/services/plooplayer/localDecryptor.js` (+ `miniXml.js`, `scriptBundler.js`, `PlooDecryptorToken.js`) | el descifrador local y su empaquetado |

No forma parte de `MatchAggregator`: la lista es de cada instalación, no un catálogo global.
Las peticiones `Plooplayer` tampoco esperan a la sincronización en frío de Vercel.

Variables opcionales: `PLOOPLAYER_LIST_TTL_MS` (600000), `PLOOPLAYER_LIST_TIMEOUT_MS` (8000),
`PLOOPLAYER_MANIFEST_DEADLINE_MS` (9000).

## Limitaciones

- AceStream necesita la app Ace Stream en el dispositivo; si no está, esos streams no abren nada.
- `cbcs` no está soportado (todas las emisiones vistas son `cenc`).
- La build `ncc` (`npm run build`, VPS/Docker) no lleva los fuentes que empaqueta
  `/plooplayer/decryptor.js` y responde 503. En Vercel (`api/index.js` usa `src/`) funciona.
- Los canales caídos de la lista (DNS, 403) se muestran igual que en la app; fallan al abrirlos.
