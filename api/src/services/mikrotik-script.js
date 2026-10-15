// Generates the one-paste RouterOS v7 onboarding script for a router.
// The script is idempotent: everything it creates carries the comment "jatelo-connect"
// and is removed first, so running it again repairs the setup instead of duplicating it.
import { planLan } from '../lib/ip.js';

const TAG = 'jatelo-connect';

/** Quote a value as a RouterOS string literal. */
export const ros = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;

const IFACE_RE = /^[A-Za-z0-9._-]{1,40}$/;
export const isValidInterfaceName = (s) => IFACE_RE.test(s);

/** Add a filter/NAT rule at the very top of its table (works on an empty table too). */
const top = (menu, rule) =>
  `:if ([:len [${menu} find]] > 0) do={ ${menu} add ${rule} place-before=0 } else={ ${menu} add ${rule} }`;

const cleanup = (menu, extra = '') => `:do { ${menu} remove [find comment=${ros(TAG)}${extra}] } on-error={}`;

/**
 * @param {object} p
 * @param {object} p.router        router row (with hotspot/pppoe settings)
 * @param {string} p.privateKey    router WireGuard private key (plain)
 * @param {string} p.apiPassword   RouterOS API user password (plain)
 * @param {string} p.setupToken    one-time registration token
 * @param {object} p.env           { hubPublicKey, serverIp, wgPort, radiusSecret, radiusHost, radiusBackupHost, apiPort, portalHost }
 */
export function buildMikrotikScript({ router, privateKey, apiPassword, setupToken, env }) {
  const t = router.tunnel_ip;
  const hs = planLan(router.hotspot_network);
  const ppp = planLan(router.pppoe_network);
  const wan = router.wan_interface;
  const ports = (router.hotspot_ports || []).filter(isValidInterfaceName);
  const pppoeIf = router.pppoe_interface || 'jc-hotspot';
  const hub = '10.88.0.1';
  const base = `http://${hub}:${env.apiPort}/internal/routers`;
  const L = [];
  const add = (...lines) => L.push(...lines);

  add(
    `# ================================================================`,
    `#  Jatelo Connect onboarding — ${router.name.replace(/[\r\n]/g, ' ')}`,
    `#  Paste everything into Winbox > New Terminal (or SSH). Safe to run again.`,
    `#  Generated ${new Date().toISOString()}. Valid for 24 hours.`,
    `# ================================================================`,
    `:if ([:tonum [:pick [/system resource get version] 0 1]] < 7) do={ :error "Jatelo Connect needs RouterOS v7. Upgrade first: System > Packages > Check for updates." }`,
    `:log info "Jatelo Connect: setup starting"`,
    `:put "Jatelo Connect: configuring, please wait..."`,
    '',
    `# ---- 0. Remove any previous Jatelo Connect setup ----`,
    `:do { /ip hotspot remove [find name="jc-hotspot"] } on-error={}`,
    cleanup('/ip hotspot profile'),
    `:do { /ip hotspot profile remove [find name="jc-hsprof"] } on-error={}`,
    `:do { /ip hotspot user profile remove [find name="jc-users"] } on-error={}`,
    cleanup('/ip hotspot walled-garden'),
    cleanup('/ip hotspot walled-garden ip'),
    `:do { /interface pppoe-server server remove [find service-name="jatelo"] } on-error={}`,
    `:do { /ppp profile remove [find name="jc-pppoe"] } on-error={}`,
    `:do { /ip dhcp-server remove [find name="jc-hs-dhcp"] } on-error={}`,
    cleanup('/ip dhcp-server network'),
    `:do { /ip pool remove [find name="jc-hs-pool"] } on-error={}`,
    `:do { /ip pool remove [find name="jc-ppp-pool"] } on-error={}`,
    cleanup('/ip firewall filter'),
    cleanup('/ip firewall nat'),
    cleanup('/radius'),
    cleanup('/interface list member'),
    cleanup('/interface bridge port'),
    cleanup('/ip address'),
    `:do { /interface bridge remove [find name="jc-hotspot"] } on-error={}`,
    `:do { /interface wireguard peers remove [find comment=${ros(TAG)}] } on-error={}`,
    `:do { /interface wireguard remove [find name="jc-wg"] } on-error={}`,
    `:do { /user remove [find name=${ros(router.api_username)}] } on-error={}`,
    `:do { /user group remove [find name="jc-api"] } on-error={}`,
    '',
    `# ---- 1. Secure tunnel to the platform ----`,
    `/interface wireguard add name=jc-wg listen-port=13231 private-key=${ros(privateKey)} comment=${ros(TAG)}`,
    `/interface wireguard peers add interface=jc-wg public-key=${ros(env.hubPublicKey)} endpoint-address=${env.serverIp} endpoint-port=${env.wgPort} allowed-address=${hub}/32 persistent-keepalive=25s comment=${ros(TAG)}`,
    `/ip address add address=${t}/16 interface=jc-wg comment=${ros(TAG)}`,
    top('/ip firewall filter', `chain=input in-interface=jc-wg src-address=${hub} action=accept comment=${ros(TAG)}`),
    '',
    `# ---- 2. RADIUS (login, usage, disconnect) ----`,
    `/radius add address=${env.radiusHost} secret=${ros(env.radiusSecret)} service=hotspot,ppp src-address=${t} timeout=3s comment=${ros(TAG)}`,
  );
  if (env.radiusBackupHost) {
    add(`/radius add address=${env.radiusBackupHost} secret=${ros(env.radiusSecret)} service=hotspot,ppp src-address=${t} timeout=3s comment=${ros(TAG)}`);
  }
  add(
    `/radius incoming set accept=yes port=3799`,
    '',
    `# ---- 3. Management access for the platform (tunnel only) ----`,
    `/user group add name=jc-api policy=read,write,api,rest-api,test,reboot,sensitive comment=${ros(TAG)}`,
    `/user add name=${ros(router.api_username)} group=jc-api password=${ros(apiPassword)} address=${hub}/32 comment=${ros(TAG)}`,
    `/ip service set api disabled=no`,
    `/ip dns set allow-remote-requests=yes`,
    '',
  );

  if (router.hotspot_enabled) {
    add(
      `# ---- 4. WiFi hotspot ----`,
      `/interface bridge add name=jc-hotspot comment=${ros(TAG)}`,
    );
    for (const p of ports) {
      add(
        `:do { /interface bridge port remove [find interface=${ros(p)}] } on-error={}`,
        `/interface bridge port add bridge=jc-hotspot interface=${ros(p)} comment=${ros(TAG)}`,
      );
    }
    add(
      `:if ([:len [/interface list find name="LAN"]] > 0) do={ /interface list member add list=LAN interface=jc-hotspot comment=${ros(TAG)} }`,
      `/ip address add address=${hs.gateway}/${hs.prefix} interface=jc-hotspot comment=${ros(TAG)}`,
      `/ip pool add name=jc-hs-pool ranges=${hs.poolStart}-${hs.poolEnd} comment=${ros(TAG)}`,
      `/ip dhcp-server add name=jc-hs-dhcp interface=jc-hotspot address-pool=jc-hs-pool lease-time=1h disabled=no comment=${ros(TAG)}`,
      `/ip dhcp-server network add address=${hs.cidr} gateway=${hs.gateway} dns-server=${hs.gateway} comment=${ros(TAG)}`,
      `/ip hotspot profile add name=jc-hsprof hotspot-address=${hs.gateway} dns-name="login.wifi" html-directory=jc-hotspot login-by=http-pap,http-chap,mac-cookie use-radius=yes radius-accounting=yes radius-interim-update=5m nas-port-type=wireless-802.11 http-cookie-lifetime=1d`,
      `/ip hotspot user profile add name=jc-users shared-users=20 keepalive-timeout=5m status-autorefresh=1m add-mac-cookie=yes mac-cookie-timeout=1d`,
      `/ip hotspot add name=jc-hotspot interface=jc-hotspot profile=jc-hsprof address-pool=none idle-timeout=5m disabled=no`,
      `/ip hotspot walled-garden ip add dst-address=${env.serverIp} action=accept comment=${ros(TAG)}`,
      `/ip hotspot walled-garden add dst-host=${ros(env.portalHost)} action=allow comment=${ros(TAG)}`,
      `/ip firewall nat add chain=srcnat src-address=${hs.cidr} out-interface=${ros(wan)} action=masquerade comment=${ros(TAG)}`,
      '',
    );
  }

  if (router.pppoe_enabled) {
    add(
      `# ---- 5. PPPoE subscribers ----`,
      `/ip pool add name=jc-ppp-pool ranges=${ppp.poolStart}-${ppp.poolEnd} comment=${ros(TAG)}`,
      `/ppp profile add name=jc-pppoe local-address=${ppp.gateway} remote-address=jc-ppp-pool dns-server=${ppp.gateway} only-one=yes interface-list=LAN`,
      `/interface pppoe-server server add service-name=jatelo interface=${ros(pppoeIf)} default-profile=jc-pppoe authentication=pap,chap,mschap2 one-session-per-host=yes disabled=no`,
      `/ppp aaa set use-radius=yes accounting=yes interim-update=5m`,
      `/ip firewall nat add chain=srcnat src-address=${ppp.cidr} out-interface=${ros(wan)} action=masquerade comment=${ros(TAG)}`,
      '',
      `# Expired subscribers stay connected but can only reach the payment page`,
      top('/ip firewall filter', `chain=forward src-address-list=jc-expired action=reject reject-with=icmp-network-unreachable comment=${ros(TAG)}`),
      top('/ip firewall filter', `chain=forward src-address-list=jc-expired protocol=udp dst-port=53 action=accept comment=${ros(TAG)}`),
      top('/ip firewall filter', `chain=forward src-address-list=jc-expired dst-address=${env.serverIp} action=accept comment=${ros(TAG)}`),
      `/ip firewall nat add chain=dstnat src-address-list=jc-expired protocol=tcp dst-port=80 dst-address=!${env.serverIp} action=dst-nat to-addresses=${env.serverIp} to-ports=80 comment=${ros(TAG)}`,
      '',
    );
  }

  add(
    `# ---- 6. Hotspot pages and registration (through the tunnel) ----`,
    `:local jcOk false`,
    `:for i from=1 to=12 do={`,
    `  :if (!$jcOk) do={`,
    `    :do {`,
  );
  if (router.hotspot_enabled) {
    for (const f of ['login.html', 'rlogin.html', 'alogin.html', 'status.html', 'logout.html', 'error.html']) {
      add(`      /tool fetch url=${ros(`${base}/hotspot-file/${f}?token=${setupToken}`)} dst-path=${ros(`jc-hotspot/${f}`)} output=file`);
    }
  }
  add(
    `      :local jcId [/system identity get name]`,
    `      :local jcVer [/system resource get version]`,
    `      :local jcBoard [/system resource get board-name]`,
    `      :local jcSerial ""`,
    `      :do { :set jcSerial [/system routerboard get serial-number] } on-error={}`,
    `      /tool fetch url=${ros(`${base}/register`)} http-method=post http-header-field="Content-Type: application/json" http-data=("{\\"token\\":\\"${setupToken}\\",\\"identity\\":\\"" . $jcId . "\\",\\"version\\":\\"" . $jcVer . "\\",\\"board\\":\\"" . $jcBoard . "\\",\\"serial\\":\\"" . $jcSerial . "\\"}") output=none`,
    `      :set jcOk true`,
    `    } on-error={ :delay 5s }`,
    `  }`,
    `}`,
    `:if ($jcOk) do={`,
    `  :log info "Jatelo Connect: setup complete"`,
    `  :put "Jatelo Connect: setup complete. This router is now online in your dashboard."`,
    `} else={`,
    `  :log error "Jatelo Connect: could not reach the platform through the tunnel"`,
    `  :put "Jatelo Connect: the tunnel did not come up. Check that ${wan} has internet, then run this script again."`,
    `}`,
  );
  return L.join('\n') + '\n';
}

/** Hotspot HTML served to the router. MikroTik replaces $(var) before sending to the phone. */
export function hotspotFile(name, { portalUrl, routerId }) {
  const portal = `${portalUrl.replace(/\/$/, '')}/h/${routerId}`;
  const shell = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WiFi</title></head><body style="font-family:sans-serif;text-align:center;padding:40px">${body}</body></html>\n`;
  const toPortal = (path, fields) => shell(
    `<form name="f" action="${portal}${path}" method="get">${fields.map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`).join('')}`
    + `<noscript><button type="submit">Continuer / Komeza / Continue</button></noscript></form><script>document.f.submit()</script>`,
  );
  switch (name) {
    case 'login.html':
    case 'rlogin.html':
      return toPortal('', [['mac', '$(mac)'], ['ip', '$(ip)'], ['ll', '$(link-login-only)'], ['dst', '$(link-orig)'], ['err', '$(error)'], ['u', '$(username)']]);
    case 'alogin.html':
      return toPortal('/ok', [['u', '$(username)'], ['mac', '$(mac)'], ['dst', '$(link-orig)'], ['lo', '$(link-logout)']]);
    case 'status.html':
      return toPortal('/status', [['u', '$(username)'], ['mac', '$(mac)'], ['lo', '$(link-logout)'], ['up', '$(uptime)'], ['left', '$(session-time-left)']]);
    case 'logout.html':
      return toPortal('/bye', [['u', '$(username)'], ['mac', '$(mac)']]);
    case 'error.html':
      return toPortal('', [['err', '$(error)'], ['ll', '$(link-login-only)'], ['mac', '$(mac)']]);
    default:
      return null;
  }
}
