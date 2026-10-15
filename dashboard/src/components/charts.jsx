// Two hand-built SVG charts: stacked daily revenue bars and a bandwidth line chart.
// Series colours follow the validated order (blue, amber, green); each chart has a
// legend, hover tooltips and recessive grid lines.
import { useEffect, useRef, useState } from 'react';

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** "Nice" axis maximum and 4 ticks. */
function niceTicks(max) {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const top = Math.ceil(max / step) * step;
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}

const shortMoney = (v) => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(v));

export function RevenueChart({ days, series, fmtMoney, fmtDay, height = 220 }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const pad = { l: 44, r: 8, t: 8, b: 24 };
  const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
  const totals = days.map((d) => series.reduce((s, x) => s + Number(d[x.key] || 0), 0));
  const { top, ticks } = niceTicks(Math.max(...totals, 0));
  const slot = iw / Math.max(1, days.length);
  const bw = Math.max(3, Math.min(28, slot - 2)); // 2px surface gap between bars
  const y = (v) => pad.t + ih - (v / top) * ih;
  const labelEvery = Math.ceil(days.length / Math.max(2, Math.floor(iw / 64)));
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div className="legend">{series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}</div>
      <svg className="chart" width={width} height={height} role="img" aria-label={series.map((s) => s.label).join(', ')}>
        <g className="grid">{ticks.map((tv) => <line key={tv} x1={pad.l} x2={width - pad.r} y1={y(tv)} y2={y(tv)} />)}</g>
        <g className="axis">
          {ticks.map((tv) => <text key={tv} x={pad.l - 6} y={y(tv) + 4} textAnchor="end">{shortMoney(tv)}</text>)}
          {days.map((d, i) => ((i % labelEvery === 0 && days.length - 1 - i >= labelEvery) || i === days.length - 1)
            && <text key={d.day} x={pad.l + slot * i + slot / 2} y={height - 6} textAnchor="middle">{fmtDay(d.day)}</text>)}
        </g>
        {days.map((d, i) => {
          const x = pad.l + slot * i + (slot - bw) / 2;
          let acc = 0;
          const segs = series.map((s) => {
            const v = Number(d[s.key] || 0);
            const y0 = y(acc), y1 = y(acc + v);
            acc += v;
            return v > 0 ? { s, y: y1, h: Math.max(0, y0 - y1 - (acc < totals[i] ? 0 : 0)) } : null;
          }).filter(Boolean);
          return (
            <g key={d.day} onMouseEnter={() => setHover({ i, x: x + bw / 2 })} onMouseLeave={() => setHover(null)}>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill="transparent" />
              {segs.map((g, k) => {
                const last = k === segs.length - 1;
                const h = Math.max(1, g.h - (last ? 0 : 2)); // 2px gap between stacked segments
                return last && h > 4
                  ? <path key={g.s.key} fill={g.s.color} d={`M${x},${g.y + h} V${g.y + 4} q0,-4 4,-4 h${bw - 8} q4,0 4,4 V${g.y + h} Z`} />
                  : <rect key={g.s.key} x={x} y={g.y} width={bw} height={h} fill={g.s.color} />;
              })}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="tip" style={{ left: Math.min(Math.max(0, hover.x - 70), width - 170), top: 20 }}>
          <b>{fmtDay(days[hover.i].day, true)}</b>
          {series.map((s) => <div key={s.key}><i style={{ display: 'inline-block', width: 8, height: 8, background: s.color, marginRight: 6, borderRadius: 2 }} />{s.label}: {fmtMoney(days[hover.i][s.key])}</div>)}
          <div style={{ marginTop: 2, fontWeight: 700 }}>{fmtMoney(totals[hover.i])}</div>
        </div>
      )}
    </div>
  );
}

export function TrafficChart({ points, fmtTime, fmtRate, labels, height = 220 }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const pad = { l: 64, r: 10, t: 8, b: 24 };
  const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
  const series = [
    { key: 'tx_bps', label: labels.download, color: 'var(--s1)' }, // router transmits = clients download
    { key: 'rx_bps', label: labels.upload, color: 'var(--s2)' },
  ];
  const max = Math.max(1, ...points.flatMap((p) => [Number(p.tx_bps), Number(p.rx_bps)]));
  const { top, ticks } = niceTicks(max);
  const t0 = points.length ? new Date(points[0].ts).getTime() : 0;
  const t1 = points.length ? new Date(points[points.length - 1].ts).getTime() : 1;
  const x = (ts) => pad.l + ((new Date(ts).getTime() - t0) / Math.max(1, t1 - t0)) * iw;
  const y = (v) => pad.t + ih - (Number(v) / top) * ih;
  const path = (k) => points.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
  const nLabels = Math.max(2, Math.floor(iw / 90));
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    let best = 0, bd = Infinity;
    points.forEach((p, i) => { const d = Math.abs(x(p.ts) - px); if (d < bd) { bd = d; best = i; } });
    setHover(best);
  };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div className="legend">{series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}</div>
      <svg className="chart" width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`${labels.download}, ${labels.upload}`}>
        <g className="grid">{ticks.map((tv) => <line key={tv} x1={pad.l} x2={width - pad.r} y1={y(tv)} y2={y(tv)} />)}</g>
        <g className="axis">
          {ticks.map((tv) => <text key={tv} x={pad.l - 6} y={y(tv) + 4} textAnchor="end">{fmtRate(tv)}</text>)}
          {points.length > 1 && Array.from({ length: nLabels }, (_, i) => {
            const p = points[Math.round((i / (nLabels - 1)) * (points.length - 1))];
            return <text key={i} x={x(p.ts)} y={height - 6} textAnchor={i === 0 ? 'start' : i === nLabels - 1 ? 'end' : 'middle'}>{fmtTime(p.ts)}</text>;
          })}
        </g>
        {series.map((s) => <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" />)}
        {hover != null && points[hover] && (
          <g>
            <line x1={x(points[hover].ts)} x2={x(points[hover].ts)} y1={pad.t} y2={pad.t + ih} stroke="var(--ink-3)" strokeDasharray="3 3" />
            {series.map((s) => <circle key={s.key} cx={x(points[hover].ts)} cy={y(points[hover][s.key])} r="4" fill={s.color} stroke="#fff" strokeWidth="2" />)}
          </g>
        )}
      </svg>
      {hover != null && points[hover] && (
        <div className="tip" style={{ left: Math.min(Math.max(0, x(points[hover].ts) - 70), width - 170), top: 20 }}>
          <b>{fmtTime(points[hover].ts, true)}</b>
          {series.map((s) => <div key={s.key}>{s.label}: {fmtRate(points[hover][s.key])}</div>)}
        </div>
      )}
    </div>
  );
}
