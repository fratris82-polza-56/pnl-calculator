#!/bin/sh
# Деплой кода plan-zvezda из клона (polza-ru-retail) в прод-путь.
# Прод-контейнер смонтирован: workspace/plan-zvezda -> /app.
# data/ (БД), node_modules, server.log/pid НЕ трогаем — их нет в git.
# Использование: ./deploy-to-prod.sh   (из корня клона или откуда угодно)
set -eu
REPO="/opt/ai-sandbox/workspace/polza-ru-retail"
SRC="$REPO/plan-zvezda"
DST="/opt/ai-sandbox/workspace/plan-zvezda"
[ -d "$REPO/.git" ] || { echo "нет .git в $REPO"; exit 1; }
[ -d "$DST" ] || { echo "нет прод-пути $DST"; exit 1; }

# 1) Деплоим только запушенное: клон должен быть равен origin/master
cd "$REPO"
git fetch -q origin
BEHIND=$(git rev-list --count master..origin/master)
AHEAD=$(git rev-list --count origin/master..master)
if [ "$BEHIND" != "0" ]; then echo "Клон отстаёт от origin/master на $BEHIND — сначала git pull"; exit 1; fi
if [ "$AHEAD" != "0" ]; then echo "Локальные коммиты не запушены ($AHEAD) — сначала git push"; exit 1; fi

# 2) Копия кода в прод-путь (git ls-files plan-zvezda/*; data/ и node_modules в git не входят)
git ls-files 'plan-zvezda/*' | sed 's|^plan-zvezda/||' > /tmp/pz-deploy-files.txt
N=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$SRC/$f" ] || continue
  mkdir -p "$DST/$(dirname "$f")"
  cp -p "$SRC/$f" "$DST/$f"
  N=$((N+1))
done < /tmp/pz-deploy-files.txt

echo "Задеплоено файлов: $N (HEAD: $(git rev-parse --short HEAD))"
echo "Правки server.mjs/db.mjs? Тогда: docker restart plan-zvezda"
