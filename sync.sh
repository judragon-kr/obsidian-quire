#!/usr/bin/env bash
# 리포의 세 파일을 볼트 플러그인 폴더로 복사한다.
# 심볼릭 링크를 안 쓰는 이유 — iCloud 가 링크를 따라가지 않아 아이패드에 안 실린다.
set -euo pipefail
DEST="${QUIRE_VAULT:-$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian Vault}/.obsidian/plugins/quire"
mkdir -p "$DEST"
cp main.js manifest.json styles.css "$DEST/"
echo "→ $DEST"
