#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Генерирует коды PNL1.<base64url> для 5 аптек из плана «План_Звезда_для_аптек»
(данные зашиты в plan_polza_2026.html) и пишет их в лист «Планы» через вебхук.
Код совместим с кнопкой «План → код» в калькуляторе.
Запуск: HOOK_TOKEN=... python3 gen_plan_codes.py [--write]
"""
import base64
import json
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).parent
HOOK_URL = re.search(r'https://script\.google\.com/macros/s/[^\'"\s]+/exec',
                     (HERE / '../gsheet-hook/Code.gs').read_text()).group(0)
TOKEN = __import__('os').environ['HOOK_TOKEN']

h = (HERE / 'plan_polza_2026.html').read_text(encoding='utf-8')
D = json.loads(re.search(r'const D = (\{.*?\});', h, re.S).group(1))

# сентябрь–декабрь 2026; план на месяц = to[i], vd[i]; расходы = vd - (op-прибыль неизвестна из PDF) → op = vd - 35% vd (мок не годится)
# В PDF-плане есть только ТО и ВД. Оценка расходов: из калькулятора Артёма неизвестна → пишем exp=0 (уточнит Артём).
def code_for(ph, i):
    payload = {
        't': 'plan', 'd': f'2026-{9+i:02d}-01',
        'rev': ph['to'][i], 'vd': ph['vd'][i], 'exp': 0, 'op': 0, 'np': 0,
        'rw': ph['to'][i], 'rr': 0, 're': 0,
        'mr': round(ph['vd'][i] / ph['to'][i] * 100, 1), 'me': 0, 'mw': round(ph['vd'][i] / ph['to'][i] * 100, 1),
    }
    b = base64.urlsafe_b64encode(json.dumps(payload, separators=(',', ':')).encode()).decode().rstrip('=')
    return 'PNL1.' + b

MONTHS = ['Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
rows = []
for ph in D['pharm']:
    for i, mn in enumerate(MONTHS):
        c = code_for(ph, i)
        rows.append(['2026-09-17', ph['name'], f'2026-{9+i:02d}-01',
                     ph['to'][i], ph['vd'][i], 0, 0, 0,
                     ph['to'][i], 0, 0,
                     round(ph['vd'][i]/ph['to'][i]*100, 1), 0, round(ph['vd'][i]/ph['to'][i]*100, 1),
                     c])

print(f'{len(rows)} строк (5 аптек x 4 месяца). Пример кода Азовская/сентябрь:')
print(rows[0][14])

if '--write' in sys.argv:
    body = json.dumps({'token': TOKEN, 'sheet': 'Планы', 'createIfMissing': True, 'appendRow': None}, ensure_ascii=False)
    out_all = []
    for r in rows:
        body = json.dumps({'token': TOKEN, 'sheet': 'Планы', 'createIfMissing': True, 'appendRow': r}, ensure_ascii=False)
        p = subprocess.run(['curl', '-s', '-D', '-', '-o', '/dev/null', '--max-time', '30', '-X', 'POST',
                            '-H', 'Content-Type: application/json', '-d', body, HOOK_URL], capture_output=True, text=True)
        loc = next((l.split(' ')[1].strip() for l in p.stdout.split('\n') if l.lower().startswith('location:')), None)
        resp = subprocess.run(['curl', '-s', '--max-time', '30', loc], capture_output=True, text=True).stdout
        out_all.append(resp.strip())
    ok = sum(1 for r in out_all if '"ok":true' in r)
    print(f'записано {ok}/{len(rows)}')
else:
    print('(dry-run; для записи: --write)')
