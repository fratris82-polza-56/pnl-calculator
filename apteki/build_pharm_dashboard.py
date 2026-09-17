#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Дашборд 5 аптек: план/факт, селектор аптеки, KPI, графики.
Самодостаточный HTML (Chart.js инлайнится из plan_polza_2026.html).
План: зашит в plan_polza_2026.html (xlsx «План_Звезда_для_аптек»), сен–дек 2026.
Факт: weeks_all.json + week37.json (парсер parse_week.py, выгрузки FastReport).
Запуск: python3 build_pharm_dashboard.py -> pharmacy_dashboard.html
"""
import json
import pathlib
import re

HERE = pathlib.Path(__file__).parent

# --- Chart.js из plan_polza_2026.html ---
plan_html = (HERE / 'plan_polza_2026.html').read_text(encoding='utf-8')
scripts = re.findall(r'<script>(.*?)</script>', plan_html, re.S)
chartjs = max(scripts, key=len)
assert len(chartjs) > 100000, 'Chart.js not found'

# --- Плановые данные (реальные) ---
D = json.loads(re.search(r'const D = (\{.*?\});', plan_html, re.S).group(1))
PHARM = D['pharm']          # name, addr, color, to[4], vd[4]
MONTHS = D['months']        # Сентябрь..Декабрь

# --- Факт: недельные выгрузки ---
weeks = [w for w in json.load(open(HERE / 'weeks_all.json', encoding='utf-8'))
         if w['to'].endswith('.2026') and w.get('all') and w['all'].get('выручка') is not None]
w37 = json.load(open(HERE / 'week37.json', encoding='utf-8'))
weeks.append({
    'from': w37['from'], 'to': w37['to'], 'year': 2026, 'week': w37['week'],
    'rose': w37['totals']['rose'], 'iz': w37['totals']['iz'], 'all': w37['totals']['all'],
    'depts': w37['rose'], 'izdepts': w37['iz'],
})
weeks.sort(key=lambda w: w['week'])

PHARM_NAMES = [p['name'] for p in PHARM]

def dept_to(d, name):
    """ТО аптеки за неделю: розница + ИЗ."""
    r = (d.get('depts') or {}).get(name) or {}
    z = (d.get('izdepts') or {}).get(name) or {}
    v = (r.get('выручка') or 0) + (z.get('выручка') or 0)
    return round(v)

def dept_vd(d, name):
    """Валовый доход (наценка) аптеки за неделю."""
    r = (d.get('depts') or {}).get(name) or {}
    z = (d.get('izdepts') or {}).get(name) or {}
    return round((r.get('прибыль') or 0) + (z.get('прибыль') or 0))

def dept_checks(d, name):
    r = (d.get('depts') or {}).get(name) or {}
    z = (d.get('izdepts') or {}).get(name) or {}
    return int((r.get('чеков') or 0) + (z.get('чеков') or 0))

# недельный факт по аптекам (только недели, где есть все 5 отделов или большинство)
FACT_WEEKS = []
for w in weeks:
    names = set((w.get('depts') or {}).keys())
    if not names:
        continue
    rec = {'week': w['week'], 'from': w['from'], 'to': w['to'], 'ph': {}}
    for name in PHARM_NAMES:
        rec['ph'][name] = {
            'to': dept_to(w, name), 'vd': dept_vd(w, name), 'checks': dept_checks(w, name),
        }
    FACT_WEEKS.append(rec)

DATA = {
    'months': MONTHS,
    'pharm': PHARM,
    'factWeeks': FACT_WEEKS[-8:],   # последние 8 недель: раньше Маяковской в выгрузках нет
    'weekPlanDivider': 4.3,   # недель в месяце для пропорции плана
    'asOf': f"нед. {FACT_WEEKS[-1]['week']} ({FACT_WEEKS[-1]['from']}–{FACT_WEEKS[-1]['to']})",
}

HTML = r'''<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Аптеки — план/факт · polza.ru</title>
<script>__CHARTJS__</script>
<style>
  :root{
    --navy:#003c88; --blue:#4277c2; --green:#6dc47b; --bright:#03c854;
    --orange:#f9a968; --gold:#ffc61a; --bg:#f7f9fc; --tx:#161e25; --mut:#8b8f92;
    --card:#ffffff; --line:#e4e9f1; --red:#e5484d;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--tx);font-size:14px}
  .wrap{max-width:1180px;margin:0 auto;padding:18px 16px 40px}

  .topbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:14px}
  .logo{width:38px;height:38px;border-radius:10px;background:var(--navy);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px}
  .topbar h1{font-size:17px;font-weight:700}
  .topbar .sub{font-size:12px;color:var(--mut)}
  .topbar .spacer{flex:1}
  .btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:#fff;color:var(--navy);
       padding:8px 14px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none}
  .btn:hover{border-color:var(--blue)}
  .up-chip{background:#e5f9ec;color:#0a7d3c;border:1px solid #b5e8c8;border-radius:99px;padding:5px 11px;font-size:11.5px;font-weight:600}

  .selector{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
  .seg{display:flex;align-items:center;gap:7px;background:#fff;border:1px solid var(--line);border-radius:99px;
       padding:8px 15px;cursor:pointer;font-size:13px;font-weight:600;color:var(--tx);transition:.15s;user-select:none}
  .seg .dot{width:9px;height:9px;border-radius:50%}
  .seg:hover{border-color:var(--blue)}
  .seg.active{background:var(--navy);border-color:var(--navy);color:#fff}
  .seg.active.all{background:var(--tx)}

  .kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:16px}
  @media(max-width:900px){.kpis{grid-template-columns:repeat(2,1fr)}}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
  .kpi .t{font-size:11.5px;color:var(--mut);font-weight:600;text-transform:uppercase;letter-spacing:.3px;margin-bottom:7px}
  .kpi .v{font-size:21px;font-weight:800;line-height:1.1}
  .kpi .p{font-size:12px;color:var(--mut);margin-top:5px}
  .kpi .badge{display:inline-block;margin-top:7px;font-size:11.5px;font-weight:700;border-radius:7px;padding:3px 8px}
  .b-green{background:#e5f9ec;color:#0a7d3c}.b-orange{background:#fff1e3;color:#a05a00}.b-red{background:#fdebec;color:#c62a2f}
  .bar{height:6px;border-radius:99px;background:#eef1f6;margin-top:9px;overflow:hidden}
  .bar i{display:block;height:100%;border-radius:99px}

  .grid2{display:grid;grid-template-columns:1.4fr 1fr;gap:12px;margin-bottom:12px}
  @media(max-width:900px){.grid2{grid-template-columns:1fr}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
  .card h3{font-size:13.5px;font-weight:700;margin-bottom:2px}
  .card .hint{font-size:11.5px;color:var(--mut);margin-bottom:10px}
  .cbox{position:relative;height:250px}

  table{width:100%;border-collapse:collapse;font-size:13px}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.3px;color:var(--mut);text-align:right;padding:8px 10px;border-bottom:1px solid var(--line)}
  th:first-child,td:first-child{text-align:left}
  td{padding:10px;border-bottom:1px solid #f0f3f8;text-align:right;white-space:nowrap}
  tr:hover td{background:#fafbfe}
  .pname{display:flex;align-items:center;gap:8px;font-weight:600}
  .pname .dot{width:9px;height:9px;border-radius:50%;flex:none}
  .addr{font-size:11px;color:var(--mut);font-weight:400}
  .st{display:inline-block;font-size:11px;font-weight:700;border-radius:7px;padding:3px 9px}
  .pos{color:#0a7d3c;font-weight:700}.neg{color:#c62a2f;font-weight:700}
  .calc-link{color:var(--navy);font-weight:600;text-decoration:none;border:1px solid var(--line);border-radius:8px;padding:5px 10px;font-size:12px}
  .calc-link:hover{border-color:var(--blue);background:#f4f8fd}
  .foot{font-size:11.5px;color:var(--mut);margin-top:14px;line-height:1.5}
</style>
</head>
<body>
<div class="wrap">

  <div class="topbar">
    <div class="logo">P</div>
    <div>
      <h1>Аптеки — план/факт</h1>
      <div class="sub">5 точек · план сен–дек 2026 · факт нед. __FIRSTWEEK__–__LASTWEEK__ · сравнение нед. __W1__–__W2__ · данные на __ASOF__</div>
    </div>
    <div class="spacer"></div>
    <span class="up-chip">Реальные данные выгрузок</span>
    <a class="btn" href="../index.html">Калькулятор</a>
  </div>

  <div class="selector" id="selector"></div>

  <div class="kpis" id="kpis"></div>

  <div class="grid2">
    <div class="card">
      <h3 id="chartTitle">Товарооборот по неделям</h3>
      <div class="hint" id="chartHint">Столбики — факт, линия — недельный план (сентябрь, пропорция 4,3 нед/мес)</div>
      <div class="cbox"><canvas id="cMain"></canvas></div>
    </div>
    <div class="card">
      <h3>Доля в товарообороте (план, сен–дек)</h3>
      <div class="hint">Суммарный ТО за 4 месяца</div>
      <div class="cbox"><canvas id="cPie"></canvas></div>
    </div>
  </div>

  <div class="card">
    <h3>Сравнение аптек — последние 2 завершённые недели (нед. __W1__–__W2__)</h3>
    <div class="hint">План за 2 недели = план сентября ÷ 4,3 × 2. ВД = наценка (розница + ИЗ)</div>
    <div style="overflow-x:auto">
      <table id="tbl">
        <thead><tr>
          <th>Аптека</th><th>ТО план (2 нед)</th><th>ТО факт</th><th>%</th>
          <th>ВД факт</th><th>Маржа факт</th><th>Ср. чек</th><th>Чеков/нед</th><th>Статус</th><th></th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="foot">
      План — xlsx «План_Звезда_для_аптек» (ТО 67,1 млн, ВД 14,9 млн, маржа 22,2%).
      Факт — еженедельные выгрузки FastReport (розница + ИЗ), недели 2026 г. Обновляется после парсинга новой недели.
      «В калькулятор» открывает P&L-калькулятор этой аптеки.
    </div>
  </div>

</div>

<script>
const DATA = __DATA__;
const PH = DATA.pharm;
const FACT = DATA.factWeeks;
const LAST2 = FACT.slice(-2);              // последние 2 завершённые недели
const PLAN_W = p => p.to[0] / DATA.weekPlanDivider;   // недельный план сентября

const fmtM = n => (n/1e6).toLocaleString('ru-RU',{maximumFractionDigits:2})+' млн';
const fmtK = n => n>=1e6 ? fmtM(n) : Math.round(n/1000).toLocaleString('ru-RU')+' тыс ₽';
const fmtP = (n,d=1) => (n>=0?'+':'')+n.toFixed(d).replace('.',',')+'%';

Chart.defaults.color = '#8b8f92';
Chart.defaults.font.family = "-apple-system,'Segoe UI',Roboto,sans-serif";
Chart.defaults.font.size = 11;
const GRID = {color:'#eff2f7'};
const TT = {backgroundColor:'#161e25',borderColor:'#003c88',borderWidth:1,titleColor:'#fff',bodyColor:'#dfe6f0',
            padding:11,cornerRadius:9,boxPadding:4,displayColors:true,
            callbacks:{label:c=>' '+c.dataset.label+': '+fmtK(c.parsed.y ?? c.parsed)}};
const LEG = {position:'bottom',labels:{boxWidth:9,usePointStyle:true,pointStyle:'rectRounded',padding:12}};

let current = 'all';
let mainChart = null, pieChart = null;

/* ---------- Селектор ---------- */
const sel = document.getElementById('selector');
function addSeg(id, label, color, all){
  const b = document.createElement('div');
  b.className = 'seg' + (all?' all':'');
  b.dataset.id = id;
  b.innerHTML = (color?'<span class="dot" style="background:'+color+'"></span>':'') + label;
  b.onclick = () => select(id);
  sel.appendChild(b);
}
addSeg('all','Все аптеки',null,true);
PH.forEach(p => addSeg(p.name, p.name, p.color));

function select(id){
  current = id;
  document.querySelectorAll('.seg').forEach(s => s.classList.toggle('active', s.dataset.id===id));
  renderKpis(); renderMain(); renderTable(); highlightPie();
}
function highlightPie(){
  if (!pieChart) return;
  const idx = PH.findIndex(p => p.name === current);
  const ds = pieChart.data.datasets[0];
  ds.backgroundColor = PH.map((p,i) => (current==='all' || i===idx) ? p.color : p.color+'55');
  ds.offset = PH.map((p,i) => (i===idx ? 14 : 0));
  pieChart.update();
}

/* ---------- Агрегаты ---------- */
function weekTo(rec, name){          // ТО аптеки за неделю (null если недели нет)
  return rec.ph[name] ? rec.ph[name].to : null;
}
function sumLast2(name){             // факт за 2 последние недели
  return LAST2.reduce((s,r) => s + (weekTo(r,name)||0), 0);
}
function vdLast2(name){
  return LAST2.reduce((s,r) => s + ((r.ph[name]||{}).vd||0), 0);
}
function checksLast2(name){
  return LAST2.reduce((s,r) => s + ((r.ph[name]||{}).checks||0), 0);
}

/* ---------- KPI ---------- */
function badgeCls(pct){ return pct>=100?'b-green':pct>=85?'b-orange':'b-red'; }
function barColor(pct){ return pct>=100?'#03c854':pct>=85?'#f9a968':'#e5484d'; }

function renderKpis(){
  let factTo, factVd, planTo, planMonth, checks;
  if (current==='all'){
    factTo = LAST2.reduce((s,r)=>s+PH.reduce((a,p)=>a+(weekTo(r,p.name)||0),0),0);
    factVd = LAST2.reduce((s,r)=>s+PH.reduce((a,p)=>a+((r.ph[p.name]||{}).vd||0),0),0);
    planTo = PH.reduce((a,p)=>a+PLAN_W(p)*2,0);
    planMonth = PH.reduce((a,p)=>a+p.to[0],0);
    checks = LAST2.reduce((s,r)=>s+PH.reduce((a,p)=>a+((r.ph[p.name]||{}).checks||0),0),0);
  } else {
    factTo = sumLast2(current); factVd = vdLast2(current); checks = checksLast2(current);
    const p = PH.find(x=>x.name===current);
    planTo = PLAN_W(p)*2; planMonth = p.to[0];
  }
  const pct = factTo/planTo*100;
  const margin = factTo>0 ? factVd/factTo*100 : 0;
  const kpis = [
    {t:'ТО за 2 недели', v:fmtM(factTo), p:'план '+fmtM(planTo),
     badge:Math.round(pct)+'% плана', bc:badgeCls(pct), bar:Math.min(pct,100), col:barColor(pct)},
    {t:'Валовый доход', v:fmtK(factVd), p:'за те же 2 недели'},
    {t:'Маржа факт', v:margin.toFixed(1).replace('.',',')+'%', p:'план 22,2%'},
    {t:'Чеков за неделю', v:Math.round(checks/2).toLocaleString('ru-RU'), p:'в среднем'},
    {t:'План сентября', v:fmtM(planMonth), p:'полный месяц'},
  ];
  document.getElementById('kpis').innerHTML = kpis.map(k=>`
    <div class="kpi">
      <div class="t">${k.t}</div>
      <div class="v">${k.v}</div>
      ${k.badge?`<span class="badge ${k.bc}">${k.badge}</span>`:''}
      ${k.bar!=null?`<div class="bar"><i style="width:${k.bar}%;background:${k.col}"></i></div>`:''}
      <div class="p">${k.p||''}</div>
    </div>`).join('');
}

/* ---------- Главный график: недели ---------- */
function renderMain(){
  const title = document.getElementById('chartTitle');
  const hint = document.getElementById('chartHint');
  const names = current==='all' ? PH.map(p=>p.name) : [current];
  const labels = FACT.map(r=>'нед '+r.week);
  if (current==='all'){
    title.textContent = 'Товарооборот по неделям — все аптеки';
    hint.textContent = 'Столбики — факт (розница+ИЗ), линия — недельный план сентября';
  } else {
    const p = PH.find(x=>x.name===current);
    title.textContent = p.name+' — товарооборот по неделям';
    hint.textContent = p.addr;
  }
  const colors = PH.map(p=>p.color);
  const datasets = current==='all'
    ? [{label:'Факт', data:FACT.map(r=>PH.reduce((a,p)=>a+(weekTo(r,p.name)||0),0)),
        backgroundColor:'#4277c2', borderRadius:4, order:1},
       {label:'План/нед (сен)', type:'line', data:FACT.map(()=>PH.reduce((a,p)=>a+PLAN_W(p),0)),
        borderColor:'#161e25', borderWidth:2, borderDash:[6,4], pointRadius:0, pointStyle:'line', order:0}]
    : [{label:'Факт', data:FACT.map(r=>weekTo(r,current)||0),
        backgroundColor:colors[PH.findIndex(p=>p.name===current)], borderRadius:4, order:1},
       {label:'План/нед (сен)', type:'line', data:FACT.map(()=>PLAN_W(PH.find(p=>p.name===current))),
        borderColor:'#161e25', borderWidth:2, borderDash:[6,4], pointRadius:0, pointStyle:'line', order:0}];
  if (mainChart) mainChart.destroy();
  mainChart = new Chart(document.getElementById('cMain'), {
    type:'bar',
    data:{labels, datasets},
    options:{responsive:true,maintainAspectRatio:false,animation:false,
      scales:{x:{grid:{display:false}},y:{grid:GRID,ticks:{callback:v=>fmtM(v)}}},
      plugins:{legend:LEG,tooltip:TT}}});
}

/* ---------- Пирог ---------- */
pieChart = new Chart(document.getElementById('cPie'), {
  type:'doughnut',
  data:{labels:PH.map(p=>p.name),
    datasets:[{data:PH.map(p=>p.to.reduce((a,b)=>a+b,0)),
                backgroundColor:PH.map(p=>p.color),borderColor:'#fff',borderWidth:3,hoverOffset:6}]},
  options:{responsive:true,maintainAspectRatio:false,cutout:'58%',animation:false,
    plugins:{legend:{position:'right',labels:{boxWidth:9,usePointStyle:true,pointStyle:'circle',padding:10}},
      tooltip:{...TT,callbacks:{label:c=>{const t=c.dataset.data.reduce((a,b)=>a+b,0);
        return ' '+c.label+': '+fmtM(c.parsed)+' ₽ ('+(c.parsed/t*100).toFixed(1)+'%)';}}}}}});

/* ---------- Таблица ---------- */
function renderTable(){
  const tb = document.querySelector('#tbl tbody');
  const rows = PH.map(p=>{
    const f = sumLast2(p.name), vd = vdLast2(p.name), ck = checksLast2(p.name);
    const plan2 = PLAN_W(p)*2;
    const pct = f/plan2*100;
    const dim = current!=='all' && current!==p.name;
    const avgCheck = ck>0 ? f/ck : 0;
    return `<tr style="${dim?'opacity:.35':''}">
      <td><div class="pname"><span class="dot" style="background:${p.color}"></span>
        <div>${p.name}<div class="addr">${p.addr}</div></div></div></td>
      <td>${fmtM(plan2)}</td>
      <td><b>${fmtM(f)}</b></td>
      <td class="${pct>=100?'pos':'neg'}">${fmtP(pct-100,0)}</td>
      <td>${fmtK(vd)}</td>
      <td>${f>0?(vd/f*100).toFixed(1).replace('.',','):'—'}%</td>
      <td>${avgCheck?Math.round(avgCheck).toLocaleString('ru-RU')+' ₽':'—'}</td>
      <td>${Math.round(ck/2).toLocaleString('ru-RU')}</td>
      <td><span class="st ${badgeCls(pct)}">${pct>=100?'В плане':pct>=85?'Риск':'Отставание'}</span></td>
      <td><a class="calc-link" href="../index.html?pharmacy=${encodeURIComponent(p.name)}" title="Открыть P&L-калькулятор с параметрами аптеки">В калькулятор →</a></td>
    </tr>`;
  });
  if (current==='all'){
    const f = PH.reduce((a,p)=>a+sumLast2(p.name),0);
    const vd = PH.reduce((a,p)=>a+vdLast2(p.name),0);
    const ck = PH.reduce((a,p)=>a+checksLast2(p.name),0);
    const plan2 = PH.reduce((a,p)=>a+PLAN_W(p)*2,0);
    const pct = f/plan2*100;
    rows.push(`<tr style="background:#f4f7fb;font-weight:700">
      <td>Итого</td><td>${fmtM(plan2)}</td><td>${fmtM(f)}</td>
      <td class="${pct>=100?'pos':'neg'}">${fmtP(pct-100,0)}</td>
      <td>${fmtM(vd)}</td><td>${(vd/f*100).toFixed(1).replace('.',',')}%</td>
      <td>${Math.round(f/ck).toLocaleString('ru-RU')} ₽</td><td>${Math.round(ck/2).toLocaleString('ru-RU')}</td>
      <td><span class="st ${badgeCls(pct)}">${pct>=100?'В плане':pct>=85?'Риск':'Отставание'}</span></td><td></td></tr>`);
  }
  tb.innerHTML = rows.join('');
}

select('all');
</script>
</body>
</html>
'''

out = (HTML
       .replace('__CHARTJS__', chartjs)
       .replace('__DATA__', json.dumps(DATA, ensure_ascii=False))
       .replace('__ASOF__', DATA['asOf'])
       .replace('__LASTWEEK__', str(FACT_WEEKS[-1]['week']))
       .replace('__W1__', str(FACT_WEEKS[-2]['week']))
       .replace('__FIRSTWEEK__', str(DATA['factWeeks'][0]['week']))
       .replace('__W2__', str(FACT_WEEKS[-1]['week'])))
(HERE / 'pharmacy_dashboard.html').write_text(out, encoding='utf-8')
print('OK', len(out), 'bytes; недель с разбивкой:', len(FACT_WEEKS),
      '; последняя:', DATA['asOf'])
