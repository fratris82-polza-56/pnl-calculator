#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Парсер еженедельных выгрузок аптеки.

Выгрузки — старый «.xls» (по факту SpreadsheetML XML от FastReport):
лист Page1, строка «с ДД.ММ.ГГГГ по ДД.ММ.ГГГГ», шапка «Отдел | Выручка | ...».

Использование:
    python3 parse_week.py "файл1.xls" ["файл2.xls" ...] [--out week.json]

Несколько файлов одной недели объединяются: отделы могут лежать в разных
файлах («37 2026.xls» = 5 аптек + ИЗ, «Ленин 37 2026.xls» = Аптека + её ИЗ).

Правила итогов сверены с таблицей «Неделя к неделе без ИЗ» (недели 35–36):
- деньги/чеки/артикулы/остатки — суммы по отделам;
- наценка %, чеков в день, сред чек, арт в чеке — среднее по отделам;
- «ВСЕГО» = розница + ИЗ (суммы), средние = среднее двух групп.
"""
import json
import re
import sys
import datetime
import xml.etree.ElementTree as ET

NS = '{urn:schemas-microsoft-com:office:spreadsheet}'
DEPT_ORDER = ['Азовская', 'Маяковская', 'Проспект Мира', 'Пятницкое', 'Юбилейный', 'Аптека']
PERIOD_RE = re.compile(r'с\s+(\d{2}\.\d{2}\.\d{4})\s+по\s+(\d{2}\.\d{2}\.\d{4})')

# ключи-«средние» (в итогах берётся среднее, не сумма)
RATE_KEYS = {'наценка', 'чеков_в_день', 'ср_чек', 'арт_в_чеке'}

def load_rows(path):
    root = ET.parse(path).getroot()
    sh = root.find(f'{NS}Worksheet')
    rows = []
    for r in sh.findall(f'.//{NS}Row'):
        cells = {}
        for c in r.findall(f'{NS}Cell'):
            idx = c.get(f'{NS}Index')
            i = int(idx) if idx else len(cells) + 1
            d = c.find(f'{NS}Data')
            cells[i] = d.text if d is not None else ''
        rows.append(cells)
    return rows

def num(s):
    if s is None or str(s).strip() == '':
        return None
    return float(str(s).replace(',', '.').replace('\xa0', '').replace(' ', ''))

def parse_file(path):
    """-> (период (от, до), {отдел: {показатель: значение}})"""
    rows = load_rows(path)
    period, header_i, header = None, None, {}
    for i, r in enumerate(rows):
        a = (r.get(1) or '').strip()
        m = PERIOD_RE.search(a)
        if m:
            period = (m.group(1), m.group(2))
        if a == 'Отдел':
            header_i = i
            # шапка по именам: у выгрузок колонки 16/17/18 могут съезжать
            # (Опт(ост)/Розн(ост)/Арт(ост)); привязываемся к заголовкам.
            for col, txt in r.items():
                t = (txt or '').strip().lower()
                if t == 'опт(ост)':
                    header['опт_ост'] = col
                elif t == 'розн(ост)':
                    header['розн_ост'] = col
                elif t == 'арт(ост)':
                    header['арт_ост'] = col
    if not period or header_i is None:
        raise SystemExit(f'{path}: не найден период или шапка «Отдел»')
    if not header.get('розн_ост'):
        header = {'опт_ост': 16, 'розн_ост': 18, 'арт_ост': 19}
    depts = {}
    for r in rows[header_i + 1:]:
        name = (r.get(1) or '').strip()
        if not name or name.startswith('ИТОГО'):
            break
        depts[name] = {
            'выручка': num(r.get(2)), 'опт': num(r.get(3)), 'прибыль': num(r.get(4)),
            'наценка': num(r.get(5)), 'чеков': num(r.get(8)), 'арт': num(r.get(9)),
            'чеков_в_день': num(r.get(11)), 'ср_чек': num(r.get(12)),
            'арт_в_чеке': num(r.get(13)), 'опт_ост': num(r.get(header['опт_ост'])),
            'розн_ост': num(r.get(header['розн_ост'])), 'арт_ост': num(r.get(header['арт_ост'])),
        }
    return period, depts

def merge(paths):
    period, depts = None, {}
    for p in paths:
        per, d = parse_file(p)
        if period and per != period:
            print(f'ВНИМАНИЕ: периоды различаются: {period} vs {per} ({p})', file=sys.stderr)
        period = period or per
        for k, v in d.items():
            if k in depts:
                print(f'ВНИМАНИЕ: отдел «{k}» уже был ({p}) — суммирую', file=sys.stderr)
                for kk, vv in v.items():
                    if vv is not None:
                        depts[k][kk] = (depts[k][kk] or 0) + vv
            else:
                depts[k] = v
    return period, depts

def split_iz(depts):
    rose = {k: v for k, v in depts.items() if '(ИЗ)' not in k}
    iz = {k.replace('(ИЗ)', '').strip(): v for k, v in depts.items() if '(ИЗ)' in k}
    return rose, iz

def group_total(dvals):
    out = {}
    for v in dvals:
        for k, x in v.items():
            if x is not None:
                out.setdefault(k, []).append(x)
    res = {}
    for k, xs in out.items():
        res[k] = round(sum(xs) / len(xs), 2) if k in RATE_KEYS else round(sum(xs), 2)
    return res

def combined(tot_rose, tot_iz):
    res = {}
    for k in tot_rose:
        a, b = tot_rose.get(k), tot_iz.get(k)
        if a is None:
            res[k] = b
        elif b is None:
            res[k] = a
        elif k in RATE_KEYS:
            res[k] = round((a + b) / 2, 2)
        else:
            res[k] = round(a + b, 2)
    return res

def iso_week(dmy):
    d = datetime.datetime.strptime(dmy, '%d.%m.%Y').date()
    return d.isocalendar()[1]

def dept_sorted(rose):
    keys = [d for d in DEPT_ORDER if d in rose] + [d for d in rose if d not in DEPT_ORDER]
    return {d: rose[d] for d in keys}

def _pct(new, old):
    if new is None or old in (None, 0):
        return None
    return round((new / old - 1) * 100, 2)

def _diff(new, old):
    if new is None or old is None:
        return None
    return round(new - old, 2)

def build_block(week, d_from, d_to, rose, iz, prev=None):
    """24×13 в формате листа «Неделя к неделе без ИЗ» (как блоки недель 35–36).
    prev = {'rose': {...}, 'iz': {...}} — итоги прошлой недели для строк % (опционально)."""
    def row(a=None, vals=None):
        r = [''] * 13
        if a is not None:
            r[0] = a
        if vals:
            for j, v in enumerate(vals):
                if v is not None:
                    r[j + 1] = v
        return r
    def as_int(x):
        return int(x) if x is not None and float(x).is_integer() else x
    def dv(d, *keys):
        return [as_int(d.get(k)) for k in keys]
    M12 = ('выручка', 'опт', 'прибыль', 'наценка', 'чеков', 'арт',
           'чеков_в_день', 'ср_чек', 'арт_в_чеке', 'опт_ост', 'розн_ост', 'арт_ост')
    tr, ti = group_total(rose.values()), group_total(iz.values())
    ta = combined(tr, ti)
    hdr = ['Отдел', 'Выручка', 'Опт', 'Прибыль', 'Наценка %', 'Кол чеков', 'Арт',
           'Чеков в день', 'Сред чек', 'Арт в чеке', 'Опт(ост)', 'Розн(ост)', 'Арт(ост)']
    g = [row(f'с {d_from} по {d_to}', [week]), row(), row(hdr)]
    for d, v in dept_sorted(rose).items():
        g.append(row(d, dv(v, *M12)))
    # ИТОГО розница: B,C(нет),D,E,F,G,H,I,J,K,L (без C и M — как в таблице)
    g.append(row('ИТОГО СУММА ПО ВСЕМ'))
    g.append(row(vals=[as_int(tr.get(k)) for k in
                       ('выручка', None, 'прибыль', 'наценка', 'чеков', 'арт',
                        'чеков_в_день', 'ср_чек', 'арт_в_чеке', 'опт_ост', 'розн_ост')
                       if k]))
    for d, v in dept_sorted(iz).items():
        g.append(row(d + ' (ИЗ)', dv(v, *M12)))
    g.append(row('ИТОГО СУММА ПО ВСЕМ'))
    g.append(row(vals=[as_int(ti.get(k)) for k in
                       ('выручка', None, 'прибыль', 'наценка', 'чеков', 'арт',
                        'чеков_в_день', 'ср_чек', 'арт_в_чеке') if k]))
    g.append(row('ИТОГО СУММА ПО ВСЕМ'))
    g.append(row(vals=[as_int(ta.get(k)) for k in
                       ('выручка', None, 'прибыль', 'наценка', 'чеков', 'арт',
                        'чеков_в_день', 'ср_чек', 'арт_в_чеке') if k]))
    g.append(row())
    pz = (prev or {}).get('rose', {})
    pi = (prev or {}).get('iz', {})
    g.append(row('Розница', [_pct(tr['выручка'], pz.get('выручка')), None,
                             _pct(tr['прибыль'], pz.get('прибыль')),
                             _diff(tr['наценка'], pz.get('наценка')),
                             _pct(tr['чеков'], pz.get('чеков')),
                             _pct(tr['арт'], pz.get('арт')),
                             _pct(tr['чеков_в_день'], pz.get('чеков_в_день')),
                             _pct(tr['ср_чек'], pz.get('ср_чек')), None,
                             _pct(tr['опт_ост'], pz.get('опт_ост'))]))
    g.append(row('ИЗ', [_pct(ti['выручка'], pi.get('выручка')), None,
                        _pct(ti['прибыль'], pi.get('прибыль')),
                        _diff(ti['наценка'], pi.get('наценка')),
                        _pct(ti['чеков'], pi.get('чеков')),
                        _pct(ti['арт'], pi.get('арт')),
                        _pct(ti['чеков_в_день'], pi.get('чеков_в_день')),
                        _pct(ti['ср_чек'], pi.get('ср_чек'))]))
    return g, tr, ti, ta

def main():
    argv = sys.argv[1:]
    out_path = None
    if '--out' in argv:
        i = argv.index('--out')
        out_path = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    prev_path = None
    if '--prev' in argv:
        i = argv.index('--prev')
        prev_path = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    args = argv
    if not args:
        raise SystemExit(__doc__)
    period, depts = merge(args)
    rose, iz = split_iz(depts)
    week = iso_week(period[0])
    prev = None
    if prev_path:
        pj = json.load(open(prev_path, encoding='utf-8'))
        prev = {'rose': pj['totals']['rose'], 'iz': pj['totals']['iz']}
    block, tr, ti, ta = build_block(week, period[0], period[1], rose, iz, prev=prev)
    data = {
        'week': week, 'from': period[0], 'to': period[1],
        'files': [a for a in args],
        'rose': dept_sorted(rose), 'iz': dept_sorted(iz),
        'totals': {'rose': tr, 'iz': ti, 'all': ta},
        'block': block,
    }
    js = json.dumps(data, ensure_ascii=False, indent=1)
    if out_path:
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(js)
        print(f'OK: неделя {week} ({period[0]}–{period[1]}), отделов: '
              f'{len(rose)}+{len(iz)} ИЗ -> {out_path}', file=sys.stderr)
    else:
        print(js)

if __name__ == '__main__':
    main()
