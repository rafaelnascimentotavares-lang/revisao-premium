#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Instale o Node.js (https://nodejs.org) e abra de novo."; read -n1; exit 1; }
[ -d node_modules ] || npm install
(sleep 4; open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null) &
npm run demo
