// Server-rendered captive portal shell. One self-contained page (no external assets) that
// renders the hotspot, connected, status, logged-out, renewal and sign-up views.
import { STRINGS } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, '');

const CSS = `
:root{--c:#0E7C66;--ink:#16211f;--muted:#5d6b68;--line:#dfe6e4;--bg:#f5f8f7;--card:#fff;--err:#b42318;--ok:#067647}
*{box-sizing:border-box}html,body{margin:0}body{font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{background:var(--c);color:#fff;padding:18px 16px 22px}header .top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px}.brand img{height:36px;width:auto;border-radius:6px;background:#fff}
.langs{display:flex;gap:4px}.langs button{background:rgba(255,255,255,.15);color:#fff;border:0;border-radius:6px;padding:6px 9px;font:600 13px system-ui}
.langs button[aria-pressed=true]{background:#fff;color:var(--c)}header p{margin:10px 0 0;opacity:.92}
main{max-width:520px;margin:-12px auto 32px;padding:0 12px}section{background:var(--card);border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
h2{font-size:17px;margin:0 0 12px}.pk{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;text-align:left;border:1.5px solid var(--line);background:#fff;border-radius:12px;padding:14px;margin-bottom:8px;font:inherit;color:inherit}
.pk:active{border-color:var(--c)}.pk b{display:block}.pk small{color:var(--muted)}.pk .price{font-weight:700;color:var(--c);white-space:nowrap}
label{display:block;font-weight:600;font-size:14px;margin:10px 0 6px}input,select,textarea{width:100%;font:inherit;padding:12px;border:1.5px solid var(--line);border-radius:10px;background:#fff}
input:focus,select:focus,textarea:focus{outline:2px solid var(--c);border-color:var(--c)}.code{text-transform:uppercase;letter-spacing:.12em;font-weight:700}
.btn{display:block;width:100%;border:0;border-radius:10px;padding:14px;font:700 16px system-ui;background:var(--c);color:#fff;margin-top:12px;text-align:center;text-decoration:none}
.btn.ghost{background:transparent;color:var(--c);border:1.5px solid var(--c)}.btn[disabled]{opacity:.6}
.row{display:flex;gap:8px}.row>*{flex:1}.wallet{border:1.5px solid var(--line);border-radius:10px;padding:12px;background:#fff;font:700 15px system-ui;color:var(--ink)}
.wallet[aria-pressed=true]{border-color:var(--c);color:var(--c);background:color-mix(in srgb,var(--c) 8%,#fff)}
.msg{padding:10px 12px;border-radius:10px;margin-top:10px;font-size:14px}.msg.err{background:#fef3f2;color:var(--err)}.msg.ok{background:#ecfdf3;color:var(--ok)}
ol{padding-left:20px;margin:8px 0}ol li{margin:6px 0}.big{font-size:30px;font-weight:800;letter-spacing:.15em;text-align:center;padding:14px;border:2px dashed var(--c);border-radius:12px;margin:10px 0;color:var(--c)}
.stat{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line)}.stat:last-child{border:0}.muted{color:var(--muted);font-size:14px}
.spin{display:inline-block;width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--c);border-radius:50%;animation:s 1s linear infinite;vertical-align:-2px;margin-right:6px}@keyframes s{to{transform:rotate(360deg)}}
details summary{cursor:pointer;font-weight:700;list-style:none}details summary::-webkit-details-marker{display:none}details summary:after{content:"+";float:right;color:var(--muted)}details[open] summary:after{content:"−"}
footer{text-align:center;color:var(--muted);font-size:13px;padding:8px 16px 24px}footer a{color:inherit}[hidden]{display:none!important}
`;

// The client app. Kept small and dependency-free for slow phones.
const JS = `
const C=window.__JC__;const ls={get:k=>{try{return localStorage.getItem(k)}catch(e){return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch(e){}}};let L=ls.get('jc_lang');
if(!C.languages.includes(L))L=C.default_language||'fr';
const S=()=>C.strings[L]||C.strings.fr;const $=s=>document.querySelector(s);const el=(t,a={},...k)=>{const e=document.createElement(t);for(const[x,y]of Object.entries(a)){if(x==='on')for(const[ev,fn]of Object.entries(y))e.addEventListener(ev,fn);else if(x==='html')e.innerHTML=y;else e.setAttribute(x,y)}for(const c of k.flat())if(c!=null)e.append(c.nodeType?c:document.createTextNode(c));return e};
const fmt=n=>String(Math.round(n)).replace(/\\B(?=(\\d{3})+(?!\\d))/g,' ')+' '+(C.currency||'BIF');
const t=(k,v={})=>(S()[k]||k).replace(/\\{(\\w+)\\}/g,(_,x)=>v[x]??'');
async function api(path,body){const r=await fetch('/portal-api'+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});let j={};try{j=await r.json()}catch(e){}if(!r.ok)throw Object.assign(new Error(j.error?.message||'error'),{code:j.error?.code,details:j.error?.details});return j}
function errText(e){const k='err_'+(e.code||'generic');return S()[k]||e.message||t('err_generic')}
function msg(box,text,ok){box.innerHTML='';if(text)box.append(el('div',{class:'msg '+(ok?'ok':'err')},text))}
function login(code){const q=new URLSearchParams(location.search);const ll=q.get('ll')||C.link_login;code=String(code).trim().toUpperCase();
 if(!ll){msg($('#notice'),t('err_generic'));return}const dst=q.get('dst')||'';ls.set('jc_last',code);
 location.href=ll+(ll.includes('?')?'&':'?')+'username='+encodeURIComponent(code)+'&password='+encodeURIComponent(code)+(dst?'&dst='+encodeURIComponent(dst):'')}
function dur(m){if(m==null)return'';if(m<60)return m+' min';if(m<1440)return Math.round(m/60)+' h';const d=Math.round(m/1440);return d+(L==='en'?(d>1?' days':' day'):L==='rn'?(d>1?' imisi':' umusi'):(d>1?' jours':' jour'))}
function data(mb){if(mb==null)return'';const [g,m]=L==='en'?['GB','MB']:['Go','Mo'];return mb>=1024?(+(mb/1024).toFixed(1))+' '+g:mb+' '+m}
function left(sec){if(sec==null)return t('unlimited');const d=Math.floor(sec/86400),h=Math.floor(sec%86400/3600),m=Math.floor(sec%3600/60);const dl={fr:'j',rn:' imisi',en:'d'}[L]||'j';return d?d+dl+' '+h+'h':h?h+'h '+m+'min':m+' min'}
function langBar(){const b=$('#langs');b.innerHTML='';if(C.languages.length<2)return;for(const x of C.languages)b.append(el('button',{'aria-pressed':String(x===L),on:{click:()=>{L=x;ls.set('jc_lang',x);render()}}},x.toUpperCase()))}

// ---------- payment sheet (hotspot purchase and PPPoE renewal share it) ----------
function paySheet(box,{title,amount,start,onDone}){let wallet=C.wallets[0]?.wallet,pay=null,timer=null;
 box.innerHTML='';if(!C.wallets.length){box.append(el('div',{class:'msg err'},t('err_no_channel')));return}
 const phone=el('input',{type:'tel',inputmode:'tel',autocomplete:'tel',placeholder:'79 12 34 56'});const out=el('div');
 const wb=el('div',{class:'row'},C.wallets.map(w=>el('button',{class:'wallet','aria-pressed':String(w.wallet===wallet),type:'button',on:{click:e=>{wallet=w.wallet;for(const b of wb.children)b.setAttribute('aria-pressed',String(b===e.currentTarget))}}},w.wallet==='lumicash'?'Lumicash':'EcoCash')));
 const go=el('button',{class:'btn',on:{click:async()=>{go.disabled=true;msg(out,'');try{pay=await start({phone:phone.value,wallet});showSteps()}catch(e){msg(out,errText(e))}go.disabled=false}}},t('continue'));
 box.append(el('h2',{},title),el('label',{},t('pay_with')),wb,el('label',{},t('phone')),phone,go,out);
 function showSteps(){const w=C.wallets.find(x=>x.wallet===pay.wallet)||C.wallets[0];box.innerHTML='';
  const txn=el('input',{class:'code',placeholder:'TXN…',autocomplete:'off'});const res=el('div');
  const chk=el('button',{class:'btn ghost',on:{click:async()=>{chk.disabled=true;try{const r=await api('/payments/'+pay.reference+'/claim',{secret:pay.client_secret,txn_id:txn.value});done(r)}catch(e){msg(res,errText(e))}chk.disabled=false}}},t('check'));
  box.append(el('h2',{},t('pay_title')+' · '+fmt(pay.amount)),el('ol',{},el('li',{},t('step1',{amount:fmt(pay.amount),number:w.merchant_number,name:w.merchant_name||C.brand,wallet:w.wallet==='lumicash'?'Lumicash':'EcoCash'}),el('br'),el('span',{class:'muted'},t('step1_'+w.wallet))),el('li',{},t('step_ref',{ref:pay.reference})),el('li',{},t('step2'))),
   el('p',{class:'muted'},el('span',{class:'spin'}),t('waiting')),el('label',{},t('txn_label')),txn,chk,res,el('button',{class:'btn ghost',on:{click:()=>{clearInterval(timer);render()}}},t('back')));
  timer=setInterval(async()=>{try{const r=await api('/payments/'+pay.reference+'?secret='+encodeURIComponent(pay.client_secret));if(r.status==='success')done(r);else if(r.status==='expired'){clearInterval(timer);msg(res,t('err_expired_payment'))}}catch(e){}},4000)}
 function done(r){clearInterval(timer);onDone(r)}}

// ---------- views ----------
function viewHotspot(m){const q=new URLSearchParams(location.search);
 if(q.get('err'))m.append(el('section',{},el('div',{class:'msg err'},t('router_err')+q.get('err'))));
 const pk=el('section',{},el('h2',{},t('choose')));
 for(const p of C.packages)pk.append(el('button',{class:'pk',on:{click:()=>buy(p)}},el('span',{},el('b',{},p.name),el('small',{},[dur(p.duration_minutes),data(p.data_limit_mb),p.rate_down_kbps?(+(p.rate_down_kbps/1024).toFixed(1))+' Mbps':''].filter(Boolean).join(' · '))),el('span',{class:'price'},p.price?fmt(p.price):t('free'))));
 m.append(pk);
 const code=el('input',{class:'code',placeholder:t('code_ph'),autocomplete:'off',autocapitalize:'characters',value:q.get('u')||''});const cm=el('div');
 const cb=el('button',{class:'btn',on:{click:async()=>{cb.disabled=true;msg(cm,'');try{await api('/r/'+C.router_id+'/check',{code:code.value,mac:q.get('mac')});login(code.value)}catch(e){msg(cm,errText(e))}cb.disabled=false}}},t('connect'));
 m.append(el('section',{},el('h2',{},t('have_code')),code,cb,cm));
 if(C.trial){const tm=el('div');const tb=el('button',{class:'btn ghost',on:{click:async()=>{tb.disabled=true;try{const r=await api('/r/'+C.router_id+'/trial',{mac:q.get('mac')});login(r.code)}catch(e){msg(tm,errText(e))}tb.disabled=false}}},t('trial_btn')+' · '+dur(C.trial.duration_minutes));m.append(el('section',{},el('h2',{},t('trial')),tb,tm))}
 const ph=el('input',{type:'tel',placeholder:'79 12 34 56'}),pin=el('input',{type:'tel',inputmode:'numeric',maxlength:'4'}),rm=el('div');
 const rb=el('button',{class:'btn ghost',on:{click:async()=>{rb.disabled=true;rm.innerHTML='';try{const r=await api('/r/'+C.router_id+'/recover',{phone:ph.value,pin:pin.value});if(!r.vouchers.length)msg(rm,t('none_found'));for(const v of r.vouchers)rm.append(el('button',{class:'pk',on:{click:()=>login(v.code)}},el('span',{},el('b',{},v.code),el('small',{},v.package_name)),el('span',{class:'price'},t('connect'))))}catch(e){msg(rm,errText(e))}rb.disabled=false}}},t('find'));
 m.append(el('section',{},el('details',{},el('summary',{},t('recover')),el('p',{class:'muted'},t('recover_hint')),el('label',{},t('phone')),ph,el('label',{},t('pin')),pin,rb,rm)));
 function buy(p){if(!p.price){return}const s=el('section');m.innerHTML='';m.append(s);window.scrollTo(0,0);
  paySheet(s,{title:p.name+' · '+fmt(p.price),start:({phone,wallet})=>api('/r/'+C.router_id+'/pay',{package_id:p.id,phone,wallet,mac:q.get('mac'),lang:L}),
   onDone:r=>{s.innerHTML='';s.append(el('h2',{},t('paid')),el('p',{class:'muted'},t('your_code')),el('div',{class:'big'},r.code),el('p',{class:'muted'},t('code_sms')),el('button',{class:'btn',on:{click:()=>login(r.code)}},t('connect')));setTimeout(()=>login(r.code),2500)}})}}

async function viewConnected(m,mode){const q=new URLSearchParams(location.search);const code=q.get('u')||ls.get('jc_last');const s=el('section');m.append(s);
 if(mode==='bye'){s.append(el('h2',{},t('bye')),el('a',{class:'btn',href:'/h/'+C.router_id+'?ll='+encodeURIComponent(C.link_login||'')},t('buy_more')));return}
 s.append(el('h2',{},'✓ '+t('connected')));
 if(code){try{const v=await api('/v/'+C.router_id+'/'+encodeURIComponent(code));s.append(el('div',{class:'stat'},el('span',{},t('time_left')),el('b',{},v.seconds_left==null?t('unlimited'):left(v.seconds_left))),el('div',{class:'stat'},el('span',{},t('data_left')),el('b',{},v.bytes_left==null?t('unlimited'):data(Math.round(v.bytes_left/1048576)))),el('div',{class:'stat'},el('span',{},v.package_name),el('b',{},code)))}catch(e){}}
 const dst=q.get('dst');if(dst&&mode==='ok')s.append(el('a',{class:'btn',href:dst},t('go_on')));const lo=q.get('lo');if(lo)s.append(el('a',{class:'btn ghost',href:lo},t('logout')))}

function viewRenew(m){const s=el('section');m.append(s);const ph=el('input',{type:'tel',placeholder:'79 12 34 56'});const out=el('div');
 const b=el('button',{class:'btn',on:{click:async()=>{b.disabled=true;out.innerHTML='';try{const r=await api('/renew/lookup',{phone:ph.value});if(!r.subscriptions.length)msg(out,t('no_subs'));
   for(const x of r.subscriptions)out.append(el('button',{class:'pk',on:{click:()=>pick(x,ph.value)}},el('span',{},el('b',{},x.plan_name+' · '+x.brand),el('small',{},x.username+' · '+t('expires')+' '+new Date(x.expires_at).toLocaleDateString(L==='en'?'en-GB':'fr-FR'))),el('span',{class:'price'},fmt(x.price))))}catch(e){msg(out,errText(e))}b.disabled=false}}},t('continue'));
 s.append(el('h2',{},t('renew_title')),el('p',{class:'muted'},t('renew_hint')),el('label',{},t('phone')),ph,b,out);
 function pick(x,phone){C.wallets=x.wallets;C.brand=x.brand;s.innerHTML='';paySheet(s,{title:x.plan_name+' · '+fmt(x.price),start:({phone:p,wallet})=>api('/renew/pay',{subscription_id:x.id,phone:p||phone,wallet,lang:L}),onDone:()=>{s.innerHTML='';s.append(el('h2',{},t('paid')),el('div',{class:'msg ok'},t('renew_done')))}})}}

function viewJoin(m){const s=el('section');m.append(s);const f={name:el('input',{autocomplete:'name'}),phone:el('input',{type:'tel'}),address:el('input'),notes:el('textarea',{rows:'3'})};let geo=null;
 const plan=el('select',{},el('option',{value:''},'—'),C.plans.map(p=>el('option',{value:p.id},p.name+' · '+fmt(p.price)+' / '+p.period_days+'j')));const out=el('div');
 const loc=el('button',{class:'btn ghost',type:'button',on:{click:()=>navigator.geolocation&&navigator.geolocation.getCurrentPosition(p=>{geo=p.coords;loc.textContent='✓ '+p.coords.latitude.toFixed(4)+', '+p.coords.longitude.toFixed(4)})}},t('use_location'));
 const b=el('button',{class:'btn',on:{click:async()=>{b.disabled=true;try{await api('/join/'+C.slug,{name:f.name.value,phone:f.phone.value,address:f.address.value,notes:f.notes.value,plan_id:plan.value||null,latitude:geo?.latitude,longitude:geo?.longitude});s.innerHTML='';s.append(el('div',{class:'msg ok'},t('join_done')))}catch(e){msg(out,errText(e));b.disabled=false}}}},t('send'));
 s.append(el('h2',{},t('join_title')),el('p',{class:'muted'},t('join_hint')),el('label',{},t('name')),f.name,el('label',{},t('phone')),f.phone,el('label',{},t('address')),f.address,loc,el('label',{},t('plan')),plan,el('label',{},t('notes')),f.notes,b,out)}

function render(){document.documentElement.lang=L==='rn'?'rn':L;langBar();$('#welcome').textContent=(C.welcome&&C.welcome[L])||'';$('#support').textContent=C.support_phone?t('support')+(L==='fr'?' : ':': ')+C.support_phone:'';
 const m=$('#app');m.innerHTML='';({hotspot:viewHotspot,ok:viewConnected,status:viewConnected,bye:viewConnected,renew:viewRenew,join:viewJoin})[C.mode](m,C.mode)}
render();
`;

export function renderPage({ mode, title, brand, color, logo, config }) {
  const full = { ...config, mode, strings: STRINGS };
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title || brand)}</title><style>${CSS.replace('#0E7C66', esc(color || '#0E7C66'))}</style></head>
<body><header><div class="top"><div class="brand">${logo ? `<img src="${esc(logo)}" alt="">` : ''}<span>${esc(brand)}</span></div><div class="langs" id="langs"></div></div><p id="welcome"></p></header>
<main><div id="notice"></div><div id="app"></div></main><footer><span id="support"></span><br>Jatelo Connect</footer>
<script>window.__JC__=${json(full)};</script><script>${JS}</script></body></html>`;
}
