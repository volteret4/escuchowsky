# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# mustlisten — app.py standalone

## Qué es
Flask web app que cruza scrobbles de Last.fm con listas de álbumes "must hear"
almacenadas en SQLite. El usuario introduce su nick de Last.fm, el servidor
descarga su historial de la API y lo cruza localmente con la colección elegida.

## Archivo principal
`app.py` — todo en un solo fichero (~1500 líneas). Incluye:
- Backend Flask con endpoints
- HTML/CSS/JS embebido en `HTML_TEMPLATE`

## Cómo arrancar
```bash
pip install -r requirements.txt
python app.py --db /ruta/must_hear_rym_new.db --lastfm-api-key TU_KEY
# O con variable de entorno: LASTFM_API_KEY=xxx python app.py --db ...
# Por defecto: http://127.0.0.1:5000
```

## Secretos — SOPS + age
Las credenciales se almacenan cifradas en `.encrypted.env` (commiteable).
`sops_env.py` actúa como sustituto de python-dotenv: descifra con `sops --decrypt`
e inyecta las variables en `os.environ`. Requiere `sops` y `age` instalados
y la clave age correspondiente al recipient en `.sops.yaml`.

```bash
# Verificar que las variables se cargan correctamente:
python sops_env.py

# Editar el archivo cifrado:
sops .encrypted.env
```

## Pre-commit hooks
El repo usa **gitleaks** para detectar secretos antes de cada commit.
```bash
pip install pre-commit
pre-commit install
```

## Endpoints
- `GET /`                          → UI principal
- `GET /api/collections`           → lista de colecciones de la DB
- `GET /api/collection?slug=X`     → álbumes de una colección (con géneros)
- `GET /api/scrobbles?user=X`      → descarga top albums + recientes de Last.fm
- `GET /api/scrobbles/update`      → sync incremental (compara con known_count)
- `GET /api/check_user?user=X`     → verifica usuario Last.fm
- `GET /api/cover?mbid=X`          → proxy para CoverArtArchive (evita CORS)

## Base de datos: must_hear_rym_new.db
Tablas relevantes:
- `collections`      — id, slug, name, total_albums, source_type, source_url
- `collection_albums`— collection_id, album_id, rank
- `albums`           — id, name, year, release_group_mbid, cover_url, yt_id, artist_id
- `artists`          — id, name
- `genres`           — id, name, source
- `album_genres`     — album_id, genre_id
- `user_heard`       — (no usado por la web app, solo por html_must_hear.py)

source_type values: musicbrainz | rateyourmusic | sputnikmusic | image_ocr | NULL

## UI (HTML_TEMPLATE)
Layout 2 columnas: sidebar izquierdo + contenido principal
- Sidebar: panel Colecciones (agrupadas por serie), panel Géneros, panel Fechas
- Main: input usuario, stats bar, filtros heard/missing, grid de portadas
- Modal al hacer click en una portada: cover + youtube embed + links

El cliente recibe todos los scrobbles en un solo fetch (`/api/scrobbles`) y hace
el cruce heard/missing localmente en JS — no hay llamadas al servidor al cambiar
de colección.

## Hosting — AWS EC2 (free tier)
Instancia **t2.micro** con Ubuntu 24.04. Free tier: 750h/mes durante 12 meses.

### Crear la instancia
1. AWS Console → EC2 → Launch Instance
2. AMI: Ubuntu Server 24.04 LTS
3. Tipo: t2.micro (Free tier eligible)
4. Key pair: crear uno nuevo, descargar el `.pem`
5. Security Group: abrir puertos 22 (SSH), 80 (HTTP), 443 (HTTPS)
6. Storage: 8 GB gp3 (suficiente para la DB de ~200 MB)

### Primer acceso
```bash
chmod 400 tu-key.pem
ssh -i tu-key.pem ubuntu@<IP-PUBLICA>
```

### Setup del servidor
```bash
sudo apt update && sudo apt install -y python3-pip python3-venv git nginx
git clone <repo> /home/ubuntu/escuchowsky
cd /home/ubuntu/escuchowsky
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
```

### Subir la base de datos
```bash
# Desde tu máquina local:
scp -i tu-key.pem must_hear_rym_new.db ubuntu@<IP>:/home/ubuntu/escuchowsky/
```

### Arrancar con gunicorn como servicio (systemd)
Crear `/etc/systemd/system/mustlisten.service`:
```ini
[Unit]
Description=mustlisten Flask app
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/escuchowsky
Environment="LASTFM_API_KEY=tu_key_aqui"
ExecStart=/home/ubuntu/escuchowsky/venv/bin/gunicorn -w 2 -b 127.0.0.1:5000 "app:app" --preload -- --db /home/ubuntu/escuchowsky/must_hear_rym_new.db
Restart=always

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now mustlisten
```

### Nginx como proxy inverso
```nginx
# /etc/nginx/sites-available/mustlisten
server {
    listen 80;
    server_name <IP-PUBLICA>;
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/mustlisten /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Pasar el --db a gunicorn
`app.py` lee `--db` vía `argparse` en `main()`, pero gunicorn no llama a `main()`.
Hay que asegurarse de que `DB_PATH` y `LFM_API_KEY` se inicializan antes de que
gunicorn levante los workers — revisar cómo está estructurado el arranque en `app.py`.

## Limitaciones conocidas
- La DB acabará pesando 100-200MB (completa con todas las colecciones + portadas)
- El scraping de Last.fm tarda 10-60s en usuarios con muchos scrobbles
  (usa getTopAlbums paginado + getRecentTracks)
- No hay autenticación — cualquiera con la URL puede usarla

## Mejoras pendientes
- Búsqueda de texto dentro de una colección
- Modo offline completo (guardar colecciones en localStorage)
- Comparar entre varios usuarios
- Añadir colecciones nuevas desde la UI (requeriría html_must_hear.py integrado)
