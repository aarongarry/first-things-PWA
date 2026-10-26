#!/bin/zsh
cd "$(dirname "$0")"
open http://localhost:4173
python3 -m http.server 4173 --directory dist
