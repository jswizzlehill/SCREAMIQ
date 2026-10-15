SCREAMIQ - HOW TO RUN

1. Needs Node 18 or newer. No installs needed (no npm packages).
2. Start it:   ADMIN_PASSWORD=pickAStrongPassword node server.js
   (Windows PowerShell:  $env:ADMIN_PASSWORD="pickAStrongPassword"; node server.js)
3. Players:  http://YOUR-SERVER/            (make a QR code of this link for the line sign)
4. You:      http://YOUR-SERVER/admin       (log in, add/delete codes, clear scores)

Default code on first run: SCREAM  (change it in /admin)

Hosting: any host that runs Node works (Render, Railway, Fly.io, a small VPS).
IMPORTANT: scores and codes are saved in data.json next to server.js.
Use a host with a persistent disk/volume (or set DATA_FILE to a path on one), otherwise a restart can erase them.
Use HTTPS (hosts above provide it) so the admin password isn't sent in the clear.
