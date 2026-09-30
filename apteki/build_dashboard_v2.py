#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Дашборд v2: недели 1–39 2026. Полностью статичный HTML+SVG.
Без JS, без CDN, без CSS-переменных — открывается где угодно (вложения, офлайн).
Данные: weeks_all.json (копия таблицы) + week37/38/39.json (выгрузки FastReport).
Запуск: python3 build_dashboard_v2.py  ->  dashboard_v2.html
"""
import json
import datetime
import html
import pathlib

HERE = pathlib.Path(__file__).parent

C = dict(
    bg='#0f1420', card='#171e2e', line='#243049', tx='#e8edf7', mut='#8ea0bf',
    green='#3ecf8e', red='#ff6b6b', blue='#5b9dff', gold='#ffc861', purple='#b083f0',
    card2='#1c2436',
)

esc = lambda s: html.escape(str(s), quote=True)


def rub(x, dec=0):
    if x is None:
        return '—'
    return f"{x:,.{dec}f}".replace(',', ' ').replace('.', ',')


def mln(x):
    return f"{x / 1e6:.2f}".replace('.', ',')


def pct(x, dec=1, sign=True):
    if x is None:
        return '—'
    s = f"{x:+.{dec}f}" if sign else f"{x:.{dec}f}"
    return s.replace('.', ',') + '%'


def load_weeks():
    weeks = [w for w in json.load(open(HERE / 'weeks_all.json', encoding='utf-8'))
             if w['to'].endswith('.2026') and w.get('all') and w['all'].get('выручка') is not None]
    for name in ('week37.json', 'week38.json', 'week39.json'):
        w = json.load(open(HERE / name, encoding='utf-8'))
        weeks.append({
            'from': w['from'], 'to': w['to'], 'year': 2026, 'week': w['week'],
            'rose': w['totals']['rose'], 'iz': w['totals']['iz'], 'all': w['totals']['all'],
            'depts': w['rose'], 'izdepts': w['iz'], 'src': 'выгрузки',
        })
    weeks.sort(key=lambda w: w['week'])
    return weeks


def load_prev_year():
    ws = json.load(open(HERE / 'weeks_all.json', encoding='utf-8'))
    out = {}
    for w in ws:
        if w['to'].endswith('.2025') and w.get('all') and w['all'].get('выручка') is not None:
            out[w['week']] = w['all']
    return out


def svg_wrap(W, H, parts):
    return (f'<svg viewBox="0 0 {W} {H}" style="width:100%;height:auto;display:block" '
            f'xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,Segoe UI,Roboto,Arial,sans-serif">'
            + ''.join(parts) + '</svg>')


def nice_max(v):
    import math
    if v <= 0:
        return 1
    exp = math.floor(math.log10(v))
    base = 10 ** exp
    for m in (1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10):
        if v <= m * base:
            return m * base
    return 10 * base


def grid(W, H, pad_l, pad_r, pad_t, pad_b, mx, fmt, steps=4):
    parts = []
    plot_h = H - pad_t - pad_b
    for k in range(steps + 1):
        y = pad_t + plot_h * (1 - k / steps)
        parts.append(f'<line x1="{pad_l}" y1="{y:.1f}" x2="{W - pad_r}" y2="{y:.1f}" '
                     f'stroke="{C["line"]}" stroke-width="1"/>')
        parts.append(f'<text x="{pad_l - 6}" y="{y + 3.5:.1f}" text-anchor="end" '
                     f'fill="{C["mut"]}" font-size="10">{fmt(mx * k / steps)}</text>')
    return parts


def stacked_revenue(weeks):
    W, H, pad_l, pad_r, pad_t, pad_b = 960, 250, 52, 12, 20, 28
    plot_w, plot_h = W - pad_l - pad_r, H - pad_t - pad_b
    mx = nice_max(max(w['all']['выручка'] for w in weeks))
    n = len(weeks)
    bw = plot_w / n
    bar_w = max(bw * 0.7, 3)
    f = lambda v: f"{v / 1e6:.1f}".replace('.', ',')
    parts = grid(W, H, pad_l, pad_r, pad_t, pad_b, mx, f)
    for i, w in enumerate(weeks):
        x = pad_l + i * bw + (bw - bar_w) / 2
        rv = (w.get('rose') or {}).get('выручка') or 0
        iv = (w.get('iz') or {}).get('выручка') or 0
        tot = rv + iv
        h_r = plot_h * rv / mx
        h_i = plot_h * iv / mx
        y_r = pad_t + plot_h - h_r
        y_i = y_r - h_i
        cur = w['week'] == weeks[-1]['week']
        op = 1 if cur else 0.72
        tip = (f"Неделя {w['week']} · {w['from']}–{w['to']}\n"
               f"Всего: {rub(tot)} ₽\nРозница: {rub(rv)} ₽\nИЗ: {rub(iv)} ₽")
        parts.append(f'<g><title>{esc(tip)}</title>')
        parts.append(f'<rect x="{x:.1f}" y="{y_r:.1f}" width="{bar_w:.1f}" height="{h_r:.1f}" '
                     f'fill="{C["blue"]}" opacity="{op}"/>')
        if h_i > 0.3:
            parts.append(f'<rect x="{x:.1f}" y="{y_i:.1f}" width="{bar_w:.1f}" height="{h_i:.1f}" '
                         f'fill="{C["gold"]}" opacity="{op}"/>')
        if cur:
            parts.append(f'<rect x="{x - 1.5:.1f}" y="{y_i - 1.5:.1f}" width="{bar_w + 3:.1f}" '
                         f'height="{h_r + h_i + 3:.1f}" fill="none" stroke="{C["tx"]}" '
                         f'stroke-width="1.5" rx="2"/>')
        parts.append('</g>')
        if i % 2 == 1 or cur:
            parts.append(f'<text x="{x + bar_w / 2:.1f}" y="{H - 9}" text-anchor="middle" '
                         f'fill="{C["tx"] if cur else C["mut"]}" font-size="10" '
                         f'font-weight="{"700" if cur else "400"}">{w["week"]}</text>')
    parts.append(f'<text x="{pad_l - 6}" y="{pad_t - 8}" text-anchor="end" fill="{C["mut"]}" '
                 f'font-size="10">млн ₽</text>')
    return svg_wrap(W, H, parts)


def profit_margin(weeks):
    W, H, pad_l, pad_r, pad_t, pad_b = 960, 250, 52, 46, 20, 28
    plot_w, plot_h = W - pad_l - pad_r, H - pad_t - pad_b
    profits = [w['all']['прибыль'] for w in weeks]
    margins = [w['all']['наценка'] for w in weeks if w['all'].get('наценка') is not None]
    mx = nice_max(max(profits))
    mx_m = nice_max(max(margins))
    n = len(weeks)
    bw = plot_w / n
    bar_w = max(bw * 0.7, 3)
    f = lambda v: f"{v / 1e3:.0f}".replace('.', ',')
    parts = grid(W, H, pad_l, pad_r, pad_t, pad_b, mx, f)
    for k in range(5):
        yv = mx_m * k / 4
        y = pad_t + plot_h * (1 - k / 4)
        parts.append(f'<text x="{W - pad_r + 6}" y="{y + 3.5:.1f}" fill="{C["gold"]}" '
                     f'font-size="10" opacity="0.8">{yv:.0f}%</text>')
    # bars
    for i, w in enumerate(weeks):
        x = pad_l + i * bw + (bw - bar_w) / 2
        pv = w['all']['прибыль'] or 0
        h = plot_h * pv / mx
        y = pad_t + plot_h - h
        cur = w['week'] == weeks[-1]['week']
        tip = (f"Неделя {w['week']}\nПрибыль: {rub(pv)} ₽\n"
               f"Наценка: {w['all'].get('наценка')}%")
        parts.append(f'<g><title>{esc(tip)}</title>')
        parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w:.1f}" height="{h:.1f}" '
                     f'fill="{C["green"]}" opacity="{1 if cur else 0.72}"/>')
        parts.append('</g>')
        if i % 2 == 1 or cur:
            parts.append(f'<text x="{x + bar_w / 2:.1f}" y="{H - 9}" text-anchor="middle" '
                         f'fill="{C["tx"] if cur else C["mut"]}" font-size="10" '
                         f'font-weight="{"700" if cur else "400"}">{w["week"]}</text>')
    # margin line
    pts = []
    for i, w in enumerate(weeks):
        mv = w['all'].get('наценка')
        if mv is None:
            continue
        x = pad_l + i * bw + bw / 2
        y = pad_t + plot_h * (1 - mv / mx_m)
        pts.append(f"{x:.1f},{y:.1f}")
    parts.append(f'<polyline points="{" ".join(pts)}" fill="none" stroke="{C["gold"]}" '
                 f'stroke-width="2" stroke-linejoin="round"/>')
    for i, w in enumerate(weeks):
        mv = w['all'].get('наценка')
        if mv is None:
            continue
        x = pad_l + i * bw + bw / 2
        y = pad_t + plot_h * (1 - mv / mx_m)
        if w is weeks[-1]:
            parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4" fill="{C["gold"]}"/>')
    parts.append(f'<text x="{pad_l - 6}" y="{pad_t - 8}" text-anchor="end" fill="{C["mut"]}" '
                 f'font-size="10">тыс ₽</text>')
    return svg_wrap(W, H, parts)


def checks_chart(weeks):
    W, H, pad_l, pad_r, pad_t, pad_b = 960, 250, 52, 46, 20, 28
    plot_w, plot_h = W - pad_l - pad_r, H - pad_t - pad_b
    checks = [w['all']['чеков'] or 0 for w in weeks]
    avgs = [w['all']['ср_чек'] for w in weeks if w['all'].get('ср_чек') is not None]
    mx = nice_max(max(checks))
    mx_a = nice_max(max(avgs))
    n = len(weeks)
    bw = plot_w / n
    bar_w = max(bw * 0.7, 3)
    f = lambda v: f"{v:.0f}"
    parts = grid(W, H, pad_l, pad_r, pad_t, pad_b, mx, f)
    for k in range(5):
        yv = mx_a * k / 4
        y = pad_t + plot_h * (1 - k / 4)
        parts.append(f'<text x="{W - pad_r + 6}" y="{y + 3.5:.1f}" fill="{C["purple"]}" '
                     f'font-size="10" opacity="0.85">{yv:.0f} ₽</text>')
    for i, w in enumerate(weeks):
        x = pad_l + i * bw + (bw - bar_w) / 2
        cv = checks[i]
        h = plot_h * cv / mx
        y = pad_t + plot_h - h
        cur = w['week'] == weeks[-1]['week']
        tip = (f"Неделя {w['week']}\nЧеков: {rub(cv)}\n"
               f"Средний чек: {rub(w['all'].get('ср_чек'))} ₽")
        parts.append(f'<g><title>{esc(tip)}</title>')
        parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w:.1f}" height="{h:.1f}" '
                     f'fill="{C["blue"]}" opacity="{1 if cur else 0.72}"/>')
        parts.append('</g>')
        if i % 2 == 1 or cur:
            parts.append(f'<text x="{x + bar_w / 2:.1f}" y="{H - 9}" text-anchor="middle" '
                         f'fill="{C["tx"] if cur else C["mut"]}" font-size="10" '
                         f'font-weight="{"700" if cur else "400"}">{w["week"]}</text>')
    pts = []
    for i, w in enumerate(weeks):
        av = w['all'].get('ср_чек')
        if av is None:
            continue
        x = pad_l + i * bw + bw / 2
        y = pad_t + plot_h * (1 - av / mx_a)
        pts.append(f"{x:.1f},{y:.1f}")
        if w is weeks[-1]:
            parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4" fill="{C["purple"]}"/>')
    parts.append(f'<polyline points="{" ".join(pts)}" fill="none" stroke="{C["purple"]}" '
                 f'stroke-width="2" stroke-linejoin="round"/>')
    parts.append(f'<text x="{pad_l - 6}" y="{pad_t - 8}" text-anchor="end" fill="{C["mut"]}" '
                 f'font-size="10">чеков</text>')
    return svg_wrap(W, H, parts)


def kpi_card(title, value, delta_html, sub=''):
    sub_html = f'<div class="mut sub2">{sub}</div>' if sub else ''
    return (f'<div class="card kpi"><div class="mut">{title}</div>'
            f'<div class="v">{value}</div>'
            f'<div class="d">{delta_html}</div>'
            f'{sub_html}</div>')


def delta_badge(cur, prev, invert=False, unit='%'):
    if cur is None or prev in (None, 0):
        return '<span class="mut">—</span>'
    d = (cur / prev - 1) * 100
    good = (d >= 0) != invert
    cls = 'up' if good else 'down'
    arrow = '▲' if d >= 0 else '▼'
    return f'<span class="{cls}">{arrow} {pct(d)}</span>'


def pp_badge(cur, prev):
    if cur is None or prev is None:
        return '<span class="mut">—</span>'
    d = cur - prev
    cls = 'up' if d >= 0 else 'down'
    arrow = '▲' if d >= 0 else '▼'
    return f'<span class="{cls}">{arrow} {d:+.2f}'.replace('.', ',') + ' п.п.</span>'


def legend(items):
    return ('<div class="legend">' + ''.join(
        f'<span><i style="background:{col}"></i>{esc(txt)}</span>' for txt, col in items) + '</div>')


def build():
    weeks = load_weeks()
    prev_year = load_prev_year()
    cur, prev = weeks[-1], weeks[-2]
    t, p = cur['all'], prev['all']

    # ---- year summary ----
    ytd_rev = sum(w['all']['выручка'] for w in weeks)
    ytd_pr = sum(w['all']['прибыль'] or 0 for w in weeks)
    ytd_chk = sum(w['all']['чеков'] or 0 for w in weeks)
    best = max(weeks, key=lambda w: w['all']['выручка'])
    worst = min((w for w in weeks if w['week'] > 1), key=lambda w: w['all']['выручка'])
    avg_rev = ytd_rev / len(weeks)
    margins = [w['all']['наценка'] for w in weeks if w['all'].get('наценка') is not None]
    avg_margin = sum(margins) / len(margins)

    kpis = ''.join([
        kpi_card(f'Выручка, нед. {cur["week"]}', mln(t['выручка']) + ' млн ₽',
                 delta_badge(t['выручка'], p['выручка']),
                 f"нед. {prev['week']}: {mln(p['выручка'])} млн"),
        kpi_card(f'Прибыль, нед. {cur["week"]}', rub(t['прибыль']) + ' ₽',
                 delta_badge(t['прибыль'], p['прибыль']),
                 f"нед. {prev['week']}: {rub(p['прибыль'])} ₽"),
        kpi_card(f'Чеков, нед. {cur["week"]}', rub(t['чеков']),
                 delta_badge(t['чеков'], p['чеков']),
                 f"нед. {prev['week']}: {rub(p['чеков'])}"),
        kpi_card('Средний чек', rub(t['ср_чек']) + ' ₽',
                 delta_badge(t['ср_чек'], p['ср_чек']),
                 f"нед. {prev['week']}: {rub(p['ср_чек'])} ₽"),
        kpi_card('Наценка (всего)', f"{t['наценка']:.2f}".replace('.', ',') + '%',
                 pp_badge(t['наценка'], p['наценка']),
                 f"розница {cur['rose']['наценка']:.2f}% · ИЗ {cur['iz']['наценка']:.2f}%".replace('.', ',')),
        kpi_card('Выручка с начала года', mln(ytd_rev) + ' млн ₽',
                 f'<span class="mut">{len(weeks)} недель · ср. {mln(avg_rev)} млн/нед</span>',
                 f"прибыль {mln(ytd_pr)} млн ₽"),
    ])

    # ---- charts ----
    ch1 = stacked_revenue(weeks)
    ch2 = profit_margin(weeks)
    ch3 = checks_chart(weeks)

    # ---- months ----
    months = {}
    MN = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
    for w in weeks:
        m = int(w['to'][3:5])
        d = months.setdefault(m, {'rev': 0, 'pr': 0, 'chk': 0, 'n': 0, 'marg': []})
        d['rev'] += w['all']['выручка']
        d['pr'] += w['all']['прибыль'] or 0
        d['chk'] += w['all']['чеков'] or 0
        d['n'] += 1
        if w['all'].get('наценка') is not None:
            d['marg'].append(w['all']['наценка'])
    mrows = []
    for m in sorted(months):
        d = months[m]
        mg = sum(d['marg']) / len(d['marg']) if d['marg'] else None
        mrows.append(
            f"<tr><td>{MN[m - 1]} 2026</td><td>{d['n']}</td>"
            f"<td class=num>{rub(d['rev'])}</td><td class=num>{rub(d['pr'])}</td>"
            f"<td class=num>{f'{mg:.2f}'.replace('.', ',') + '%' if mg else '—'}</td>"
            f"<td class=num>{rub(d['chk'])}</td></tr>")

    # ---- weekly table ----
    wrows = []
    cum = 0
    for i, w in enumerate(weeks):
        cum += w['all']['выручка']
        pw = weeks[i - 1]['all'] if i > 0 else None
        wow = ((w['all']['выручка'] / pw['выручка'] - 1) * 100) if (pw and pw.get('выручка')) else None
        py = prev_year.get(w['week'])
        yoy = ((w['all']['выручка'] / py['выручка'] - 1) * 100) if py else None
        cls = ' class="cur"' if w is weeks[-1] else ''
        short = ' *' if (w['week'] == 1) else ''
        wow_html = ('<span class="{}">{}%</span>'.format(
            'pos' if wow >= 0 else 'neg', f"{wow:+.1f}".replace('.', ','))
            if wow is not None else '—')
        yoy_html = ('<span class="{}">{}%</span>'.format(
            'pos' if yoy >= 0 else 'neg', f"{yoy:+.1f}".replace('.', ','))
            if yoy is not None else '—')
        marg = w['all'].get('наценка')
        wrows.append(
            f"<tr{cls}><td><strong>{w['week']}</strong>{short}</td>"
            f"<td class=l>{w['from'][:5]}–{w['to'][:5]}</td>"
            f"<td class=num>{rub(w['all']['выручка'])}</td>"
            f"<td class=num>{rub((w.get('rose') or {}).get('выручка'))}</td>"
            f"<td class=num>{rub((w.get('iz') or {}).get('выручка'))}</td>"
            f"<td class=num>{rub(w['all']['прибыль'])}</td>"
            f"<td class=num>{f'{marg:.2f}'.replace('.', ',') + '%' if marg is not None else '—'}</td>"
            f"<td class=num>{rub(w['all']['чеков'])}</td>"
            f"<td class=num>{rub(w['all']['ср_чек'])}</td>"
            f"<td class=num>{wow_html}</td><td class=num>{yoy_html}</td>"
            f"<td class=num>{rub(cum)}</td></tr>")

    # ---- dept tables (week 37) ----
    def dep2(x):
        return f"{x:.2f}".replace('.', ',') + '%'

    def dept_rows(depts, totals):
        rows = []
        for name, v in depts.items():
            rows.append(
                f"<tr><td>{esc(name)}</td><td class=num>{rub(v['выручка'])}</td>"
                f"<td class=num>{rub(v['прибыль'])}</td>"
                f"<td class=num>{dep2(v['наценка'])}</td>"
                f"<td class=num>{rub(v['чеков'])}</td><td class=num>{rub(v['ср_чек'])}</td>"
                f"<td class=num>{rub(v.get('розн_ост'))}</td></tr>")
        rows.append(
            f"<tr class=tot><td>ИТОГО</td><td class=num>{rub(totals['выручка'])}</td>"
            f"<td class=num>{rub(totals['прибыль'])}</td>"
            f"<td class=num>{dep2(totals['наценка'])}</td>"
            f"<td class=num>{rub(totals['чеков'])}</td><td class=num>{rub(totals['ср_чек'])}</td>"
            f"<td class=num>{rub(totals.get('розн_ост'))}</td></tr>")
        return ''.join(rows)

    dept_head = ("<tr><th class=l>Отдел</th><th>Выручка</th><th>Прибыль</th><th>Наценка</th>"
                 "<th>Чеков</th><th>Ср. чек</th><th>Остаток</th></tr>")
    rose_tbl = dept_rows(cur['depts'], cur['rose'])
    iz_tbl = dept_rows(cur['izdepts'], cur['iz'])

    now = datetime.datetime.now().strftime('%d.%m.%Y %H:%M')
    gen = f"сформирован {now}"

    html_doc = f"""<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Аптека · недели 1–39 2026</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:{C['bg']};color:{C['tx']};font:14px/1.45 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;padding:20px;max-width:1040px;margin:0 auto}}
h1{{font-size:20px;margin-bottom:2px}}
h2{{font-size:15px;margin-bottom:10px}}
.sub{{color:{C['mut']};font-size:12.5px;margin-bottom:16px}}
.badge{{display:inline-block;background:#233149;color:{C['blue']};border-radius:6px;padding:2px 8px;font-size:11.5px;margin-left:8px;vertical-align:2px}}
.grid{{display:grid;gap:12px}}
.kpis{{grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:12px}}
.card{{background:{C['card']};border:1px solid {C['line']};border-radius:12px;padding:14px 16px;margin-bottom:12px}}
.kpi .v{{font-size:21px;font-weight:700;margin-top:2px}}
.kpi .d{{font-size:12px;margin-top:3px}}
.sub2{{font-size:11px;margin-top:2px}}
.up,.pos{{color:{C['green']}}}
.down,.neg{{color:{C['red']}}}
.mut{{color:{C['mut']}}}
.legend{{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:8px;font-size:12px;color:{C['mut']}}}
.legend i{{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}}
table{{width:100%;border-collapse:collapse;font-size:12.5px}}
th,td{{padding:6px 8px;border-bottom:1px solid {C['line']};text-align:right;white-space:nowrap}}
th{{color:{C['mut']};font-weight:600;font-size:11.5px;position:sticky;top:0;background:{C['card']}}}
td.l,th.l{{text-align:left}}
th:first-child,td:first-child{{text-align:left}}
tr.cur td{{background:#1d2a44}}
tr.tot td{{font-weight:700;border-top:2px solid {C['line']}}}
.scroll{{overflow-x:auto;max-height:520px;overflow-y:auto}}
.note{{color:{C['mut']};font-size:11.5px;margin-top:8px}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}
@media(max-width:860px){{.two{{grid-template-columns:1fr}}}}
.ysum{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}}
.ysum .v{{font-size:18px;font-weight:700}}
</style></head><body>

<h1>Еженедельные показатели аптеки <span class="badge">2026 · недели 1–39</span></h1>
<div class="sub">Свежая неделя: <strong>№{cur['week']}, {cur['from']}–{cur['to']}</strong> (из выгрузок FastReport) · история — из таблицы «Неделя к неделе без ИЗ» + выгрузки · {gen}</div>

<div class="grid kpis">{kpis}</div>

<div class="card">
<h2>Год в цифрах (01.01–13.09.2026)</h2>
<div class="ysum">
<div><div class="mut">Выручка YTD</div><div class="v">{mln(ytd_rev)} млн ₽</div></div>
<div><div class="mut">Прибыль YTD</div><div class="v">{mln(ytd_pr)} млн ₽</div></div>
<div><div class="mut">Чеков YTD</div><div class="v">{rub(ytd_chk)}</div></div>
<div><div class="mut">Средняя наценка</div><div class="v">{avg_margin:.2f}%</div></div>
<div><div class="mut">Лучшая неделя</div><div class="v">№{best['week']} · {mln(best['all']['выручка'])} млн</div></div>
<div><div class="mut">Худшая неделя*</div><div class="v">№{worst['week']} · {mln(worst['all']['выручка'])} млн</div></div>
</div>
<div class="note">* неделя 1 (01–04.01, 4 рабочих дня) в сравнении не участвует.</div>
</div>

<div class="card">
<h2>Выручка по неделям: розница + ИЗ</h2>
{legend([('розница', C['blue']), ('ИЗ', C['gold']), ('последняя неделя', C['tx'])])}
{ch1}
<div class="note">Наведение на столбец — точные цифры недели.</div>
</div>

<div class="card">
<h2>Прибыль и наценка</h2>
{legend([('прибыль, тыс ₽ (левая ось)', C['green']), ('наценка, % (правая ось)', C['gold'])])}
{ch2}
</div>

<div class="card">
<h2>Чеки и средний чек</h2>
{legend([('чеков (левая ось)', C['blue']), ('средний чек, ₽ (правая ось)', C['purple'])])}
{ch3}
</div>

<div class="two">
<div class="card">
<h2>По месяцам</h2>
<table><tr><th class=l>Месяц</th><th>Нед.</th><th>Выручка ₽</th><th>Прибыль ₽</th><th>Наценка</th><th>Чеков</th></tr>
{''.join(mrows)}</table>
<div class="note">Месяц — по дате окончания недели; неделя 1 неполная (4 дня).</div>
</div>
<div class="card">
<h2>Последняя неделя · розница</h2>
<table>{dept_head}{rose_tbl}</table>
</div>
</div>

<div class="card">
<h2>Последняя неделя · ИЗ</h2>
<table>{dept_head.replace('Остаток', 'Остаток (ИЗ)')}{iz_tbl}</table>
</div>

<div class="card">
<h2>Все недели 2026</h2>
<div class="scroll">
<table>
<tr><th>№</th><th class=l>Период</th><th>Выручка ₽</th><th>розница ₽</th><th>ИЗ ₽</th><th>Прибыль ₽</th><th>Наценка</th><th>Чеков</th><th>Ср. чек ₽</th><th>к пред. нед.</th><th>к 2025</th><th>накопительно ₽</th></tr>
{''.join(wrows)}
</table>
</div>
<div class="note">«к 2025» — сравнение с той же ISO-неделей 2025 (данные в таблице есть с недели 31). * неделя 1: 01–04.01.2026, 4 дня.</div>
</div>

<div class="note" style="text-align:center;margin-top:4px">Источник: копия таблицы «Еженедельный Показатели Аптеки» (недели 1–36) + выгрузки FastReport из Drive «Данные для заполнения» (недели 37–39, вкл. «Ленин»). Файл автономный: графики — статичный SVG, работает без интернета.</div>
</body></html>"""
    out = HERE / 'dashboard_v2.html'
    out.write_text(html_doc, encoding='utf-8')
    print('written', out, len(html_doc.encode('utf-8')), 'bytes')


if __name__ == '__main__':
    build()
