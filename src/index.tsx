// Control Cult's Decky plugin: what Control Cult sees right now, a code to pair a phone, the controller layout, a full
// settings page (Solo voice, mic and speaker, hotkeys, speech speed, widgets, usage, invites), and the widgets the
// player pinned, kept on screen over the game while they play (the decky-pip method: Steam's UI stays composited
// like a notification, and a browser view per widget sits on top). Sideloaded; Control Cult itself runs on its own.
import { ButtonItem, PanelSection, PanelSectionRow, Field, ToggleField, DropdownItem, TextField, Navigation, Router, findModuleChild, staticClasses } from "@decky/ui";
import { callable, definePlugin, routerHook } from "@decky/api";
import { useEffect, useState } from "react";
import qrcode from "qrcode-generator";

type Status = { installed: boolean; noStatus?: boolean; connected?: boolean; tester?: string; game?: { appid?: string; name?: string | null } | null; controller?: string | null; layout?: string | null; steamOk?: boolean | null; version?: string };
type Device = { id: string; name: string; default?: boolean };
type Widget = { on: boolean; pin?: boolean };
type Settings = { error?: string; enabled: boolean; wakeWord?: boolean; wakeState?: string; wakeText?: string; drawerEnabled?: boolean; drawerHandle?: boolean; snap?: boolean; cvStyle?: string; cvStyles?: { id: string; name: string; about: string }[]; mic: string | null; speaker: string | null; speed: number; speeds: number[]; mics: Device[]; speakers: Device[]; voice?: string; voices?: { id: string; name: string; about: string }[]; voiceNote?: string | null; audioError?: string | null; hotkeys: { talk: string | null; feedback?: string | null; hide?: string | null }; widgets: Record<string, Widget> };
type Pinned = { key: string; x: number; y: number; w: number; h: number; min?: [number, number] };
type Pip = { widgets: Pinned[]; boxes?: Pinned[]; keep?: Pinned[]; full?: boolean; warm?: boolean; enabled: boolean; overlayOpen?: boolean; show?: boolean; base?: string; token?: string };

const status = callable<[], Status>("status");
const pairing = callable<[], { code?: string; url?: string; error?: string }>("pairing");
const local = callable<[string, string, any?], any>("local");
const pip = callable<[number?, string?], Pip>("pip");
type Install = { state: "idle" | "running" | "done" | "failed"; step: string; error: string };
const install = callable<[string], Install>("install");
const installState = callable<[], Install>("install_state");
const uninstall = callable<[], Install>("uninstall");

// Installing Control Cult from Game Mode: the panel alone (from a Decky store) installs the app, with the code
// the player was given; progress in plain words, what failed and Try again, then on to pairing like any install.
function InstallPanel() {
  const [code, setCode] = useState("");
  const [st, setSt] = useState<Install>({ state: "idle", step: "", error: "" });
  useEffect(() => {
    let alive = true;
    installState().then(x => { if (alive) setSt(x); }).catch(() => {});
    const t = setInterval(() => installState().then(x => { if (alive) setSt(x); }).catch(() => {}), 1000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const go = async () => setSt(await install(code).catch(() => ({ state: "failed", step: "", error: "Couldn't start the install." } as Install)));
  if (st.state === "running") return (
    <PanelSection title="Installing Control Cult">
      <PanelSectionRow><Field label={st.step || "Working…"} description="Keep the Deck on and online. This takes a few minutes." /></PanelSectionRow>
    </PanelSection>
  );
  if (st.state === "done") return (
    <PanelSection title="Control Cult">
      <PanelSectionRow><Field label="Installed" description={`${st.step} Connecting to Steam: if it doesn't, restart the Deck once.`} /></PanelSectionRow>
    </PanelSection>
  );
  return (
    <PanelSection title="Control Cult">
      <PanelSectionRow><Field label="Talk to Noob Deity to set up your controls" description="Control Cult builds and tunes your Steam Input layouts by conversation, live while you play. Install it here; it starts with your Deck." /></PanelSectionRow>
      <PanelSectionRow><TextField label="License code (optional)" description="Have one? Enter it now. If not, install first: you can get free goats right here after, no card needed." value={code} onChange={e => setCode(e.target.value)} /></PanelSectionRow>
      {st.state === "failed" ? <PanelSectionRow><Field label="The install didn't finish" description={st.error} /></PanelSectionRow> : null}
      <PanelSectionRow><ButtonItem layout="below" onClick={go}>{st.state === "failed" ? "Try again" : "Install Control Cult"}</ButtonItem></PanelSectionRow>
    </PanelSection>
  );
}

const qrSvg = (text: string) => { const q = qrcode(0, "M"); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2 }); };
const dataUrl = (svg: string) => `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
const ROUTE = "/noobdeity";
const WIDGET_NAMES: Record<string, string> = { layout: "Controller", chat: "Chat", talk: "Talk button" };

// ---- always-on widgets over the game --------------------------------------------------------------------------------
enum UIComposition { Hidden = 0, Notification = 1, Overlay = 2 }
const useUIComposition: (c: UIComposition) => void = (() => {
  try {
    return findModuleChild((m: any) => {
      if (typeof m !== "object") return undefined;
      for (const k in m) {
        const f = m[k];
        if (typeof f === "function" && f.toString().includes("AddMinimumCompositionStateRequest") && f.toString().includes("ChangeMinimumCompositionStateRequest") && f.toString().includes("RemoveMinimumCompositionStateRequest") && !f.toString().includes("m_mapCompositionStateRequests")) return f;
      }
      return undefined;
    }) || (() => {});
  } catch { return () => {}; }
})();

// The technical log (Control Cult's host reads it from Steam's UI for the feedback agent): what this plugin has on screen
// and what went wrong, as "[NoobDeity]" console lines and in window.__noobdeityDiag.
const VERSION = "1.2.16";
const diag: { version: string; events: { at: number; level: string; msg: string }[]; views: Record<string, any> } = { version: VERSION, events: [], views: {} };
(window as any).__noobdeityDiag = diag;
function ndlog(level: "info" | "warn" | "error", msg: string) {
  diag.events.push({ at: Date.now(), level, msg: String(msg).slice(0, 400) });
  if (diag.events.length > 80) diag.events.splice(0, diag.events.length - 80);
  try { (level === "error" ? console.error : level === "warn" ? console.warn : console.info)("[NoobDeity] " + msg); } catch {}
}
const errText = (e: any) => String(e?.message || e).slice(0, 200);
const noToken = (u: string) => u.replace(/([?&]t=)[^&]+/, "$1…");

function screenSize() {
  const w: any = (Router as any).WindowStore?.GamepadUIMainWindowInstance?.BrowserWindow;
  return { w: w?.innerWidth || 854, h: w?.innerHeight || 534 };
}

// Asks Steam to draw its UI over the game while it is mounted: only for views on screen, so a view kept loaded but
// hidden costs the game nothing.
function Composited() { useUIComposition(UIComposition.Notification); return null; }

// hidden: kept loaded but not shown (the widget editor is open; the drawer closed), so it is back at once.
// park: while hidden, also shrink it to one pixel in the corner, so a full-screen view can't take any touch.
function PinnedView({ name, url, x, y, w, h, hidden = false, park = false }: { name: string; url: string; x: number; y: number; w: number; h: number; hidden?: boolean; park?: boolean }) {
  const [v] = useState<{ id: string; view: any; browser: any } | null>(() => {
    const id = "noobdeity-" + Math.random().toString(36).slice(2, 7);
    try {
      const root: any = (Router as any).WindowStore?.GamepadUIMainWindowInstance;
      const view = root.CreateBrowserView(id);
      diag.views[id] = { name, id, created: Date.now() };
      ndlog("info", `view ${name} created`);
      return { id, view, browser: view.GetBrowser() };
    } catch (e) { ndlog("error", `view ${name}: could not create it: ${errText(e)}`); return null; }
  });
  useEffect(() => { if (!v) return; try { v.view.LoadURL(url); diag.views[v.id] = { ...diag.views[v.id], url: noToken(url) }; } catch (e) { ndlog("error", `view ${name}: LoadURL failed: ${errText(e)}`); } }, [url]);
  useEffect(() => {
    if (!v) return;
    const b = [x, y, w, h].map(n => Math.round(n));
    if (hidden) { try { v.browser.SetVisible(false); if (park) v.browser.SetBounds(0, 0, 1, 1); diag.views[v.id] = { ...diag.views[v.id], hidden: true }; ndlog("info", `view ${name} hidden, kept loaded`); } catch (e) { ndlog("error", `view ${name}: SetVisible failed: ${errText(e)}`); } return; }
    try { v.browser.SetBounds(b[0], b[1], b[2], b[3]); v.browser.SetVisible(true); diag.views[v.id] = { ...diag.views[v.id], bounds: b, hidden: false }; ndlog("info", `view ${name} at ${b[0]},${b[1]} size ${b[2]}×${b[3]} px`); }
    catch (e) { ndlog("error", `view ${name}: SetBounds failed: ${errText(e)}`); }
  }, [x, y, w, h, hidden]);
  useEffect(() => () => { if (!v) return; try { v.view.Destroy(); ndlog("info", `view ${name} removed`); } catch (e) { ndlog("error", `view ${name}: Destroy failed: ${errText(e)}`); } delete diag.views[v.id]; }, []);
  return hidden ? null : <Composited />;
}

// Widgets are for over a game: with no game running they would only sit on Steam's own screens and take their input.
function gameRunning() { try { const r: any = Router as any; return "MainRunningApp" in r ? !!r.MainRunningApp : true; } catch { return true; } }

// What Steam has in front. side: its open side menu (0 none, 1 the Steam menu, 2 Quick Access), which
// Control Cult uses to close the drawer when the player goes into Steam's screens. The rest is logged on every change to
// learn which one tells "the game in front" from "Steam's Library or Store over a running game" on a real Deck: none
// is confirmed yet (from decky-frontend-lib's typings of SteamUIStore and its windows).
function front() {
  const r: any = Router as any, w: any = r.WindowStore?.GamepadUIMainWindowInstance;
  const read = (f: () => any) => { try { const v = f(); return v === undefined ? null : v; } catch { return null; } };
  return {
    side: read(() => w.MenuStore.m_eOpenSideMenu),
    path: read(() => w.m_history?.location?.pathname ?? w.Navigator?.m_history?.location?.pathname),
    uiActive: read(() => r.IsGamepadUIWindowActive()),
    anyFocused: read(() => r.BIsAnyWindowFocused()),
    focusedWin: read(() => r.GetFocusedWindowInstance()?.m_strName ?? r.GetFocusedWindowInstance()?.BrowserWindow?.name),
    hasFocus: read(() => w.BrowserWindow.document.hasFocus()),
    visible: read(() => w.BrowserWindow.document.visibilityState),
    app: read(() => r.MainRunningApp?.appid ?? null),
  };
}
let lastFront = "";

// Pinned widgets are for over the game only: shown while the game itself is in front (path /apprunning, no
// side menu open), kept loaded but hidden on every Steam screen over it (the Steam menu, Quick Access, the game's
// controller settings and layout editor at /app/<id>/controllerconfigurator/..., Library, Store). A log
// (plugin 1.2.9) shows /apprunning with side=0 for the game and other paths or sides for Steam's screens. A value
// Steam doesn't report (null) doesn't hide anything, so an older Steam keeps today's behaviour. The drawer has its
// own, looser rule.
function steamScreen(f: ReturnType<typeof front>): string {
  if (typeof f.side === "number" && f.side !== 0) return f.side === 2 ? "Quick Access open" : "Steam menu open";
  if (typeof f.path === "string" && !/^\/apprunning(\/|$)/.test(f.path)) return `Steam screen in front (${f.path})`;
  return "";
}

let poke = () => {};

// What this layer drew last, told to Control Cult on each check so its touch gate keeps touches on the widgets from
// reaching the game: "full" (the drawer), "none", or "key:x,y,w,h;..." in screen percent.
let drawnNow = "none";

// Control Cult's settings page hides the widgets while it is open: a browser view takes the input where it sits, so a
// full-screen one froze the settings page (1.2.0).
let ownScreens = 0;
const ownScreen = () => { ownScreens++; window.dispatchEvent(new Event("noobdeity-screens")); return () => { ownScreens--; window.dispatchEvent(new Event("noobdeity-screens")); }; };

// A pinned widget's box on screen, in CSS px, as the widget page draws it (its minimum size, kept on screen).
function boxOf(b: Pinned, s: { w: number; h: number }) {
  const w = Math.min(s.w, Math.max(b.w / 100 * s.w, b.min?.[0] || 0)), h = Math.min(s.h, Math.max(b.h / 100 * s.h, b.min?.[1] || 0));
  const x = Math.max(0, Math.min(s.w - w, b.x / 100 * s.w)), y = Math.max(0, Math.min(s.h - h, b.y / 100 * s.h));
  return { x, y, w, h, pct: [x / s.w * 100, y / s.h * 100, w / s.w * 100, h / s.h * 100].map(v => v.toFixed(3)).join(",") };
}

function PinnedLayer() {
  const [p, setP] = useState<Pip | null>(null);
  const [hidden, setHidden] = useState(ownScreens > 0);
  useEffect(() => {
    let alive = true;
    let failing = false;
    const tick = () => { const f = front(); const k = JSON.stringify(f); if (k !== lastFront) { lastFront = k; ndlog("info", `in front: ${Object.entries(f).map(([a, b]) => `${a}=${b}`).join(" ")}`); }
      return pip(typeof f.side === "number" ? f.side : undefined, drawnNow).then(x => { if (!alive) return; if (failing) ndlog("info", "NoobDeity answering again"); failing = false; setP({ ...x, game: gameRunning(), steam: steamScreen(f) } as any); })
      .catch(e => { if (!failing) ndlog("warn", `asking NoobDeity for the widgets failed: ${errText(e)}`); failing = true; }); };
    tick();
    const t = setInterval(tick, 400);
    // Control Cult says when the editor closes, so the pinned widgets come back now, not at the next check.
    poke = tick;
    const f = () => setHidden(ownScreens > 0);
    window.addEventListener("noobdeity-screens", f);
    return () => { alive = false; poke = () => {}; clearInterval(t); window.removeEventListener("noobdeity-screens", f); };
  }, []);
  // The editor open: the pinned widgets' views stay, hidden (keep), instead of being removed and made again.
  const keep = !p?.show && p?.overlayOpen && !hidden && (p as any).game !== false ? p.keep || [] : [];
  // warm: the drawer is on, so its full-screen view stays loaded, hidden and parked, while it is closed. A pull
  // then only shows it: making and loading it on each pull took about a second.
  const warm = !!p?.warm && !!p?.base && !hidden && (p as any).game !== false;
  const why = !p?.base ? "NoobDeity not reachable" : keep.length || warm ? "" : !p.show ? "nothing to show" : hidden ? "NoobDeity settings open" : (p as any).game === false ? "no game running" : "";
  useEffect(() => { ndlog("info", why ? `widgets hidden: ${why}` : keep.length ? `widgets kept hidden while the editor is open: ${keep.map(b => b.key).join(", ")}` : `widgets shown: ${p?.full ? "drawer (full screen)" : (p?.boxes || []).map(b => b.key).join(", ")}`); }, [why, p?.full, keep.length]);
  if (why || !p) { drawnNow = "none"; return null; }
  const s = screenSize(), url = `${p.base}/w/all?t=${p.token}`;
  // The drawer open: one full-screen view. Otherwise one small view per pinned widget, so nothing else on screen is
  // covered. Touches are read by Control Cult from the touchscreen, since these views take none during play. Views that
  // aren't showing right now stay loaded but hidden where Control Cult says so (keep, warm), and the pinned ones while the
  // drawer is open, so each is back at once.
  const drawerOpen = !keep.length && !!p.show && (!!p.full || !p.boxes);
  const pinned = keep.length ? keep : drawerOpen ? p.widgets || [] : p.boxes || [];
  // Steam's own screens in front: the pinned views stay loaded but hidden, so they are back at once in the game.
  const offGame = !keep.length && !drawerOpen && !!(p as any).steam;
  drawnNow = keep.length || offGame ? "none" : drawerOpen ? "full" : pinned.map(b => `${b.key}:${boxOf(b, s).pct}`).join(";") || "none";
  return <>
    {offGame ? <OffGameLog why={(p as any).steam} /> : null}
    {pinned.map(b => { const r = boxOf(b, s); return <PinnedView key={b.key} name={b.key} url={`${url}&box=${r.pct}`} x={r.x} y={r.y} w={r.w} h={r.h} hidden={!!keep.length || drawerOpen || offGame} />; })}
    {drawerOpen || warm ? <PinnedView key="drawer" name="drawer" url={url} x={0} y={0} w={s.w} h={s.h} hidden={!drawerOpen} park /> : null}
  </>;
}

function OffGameLog({ why }: { why: string }) {
  useEffect(() => { ndlog("info", `pinned widgets kept hidden: ${why}`); return () => ndlog("info", "pinned widgets back over the game"); }, [why]);
  return null;
}

// ---- settings page ---------------------------------------------------------------------------------------------------
// The license: the Deck has no tray, so this is where its line and Enter license code live. canEnter is false in
// the Steam edition, which shows the line and takes no codes, like the tray.
// Installed but locked: the main panel asks for the license, and says where a free one comes from.
function UnlockSection() {
  const [l, setL] = useState<{ active?: boolean; free?: boolean; canEnter?: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    const look = () => local("GET", "/license").then(x => { if (alive) setL(x); }).catch(() => {});
    look();
    const t = setInterval(look, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!l || l.active !== false || l.canEnter === false) return null;
  const done = () => setL({ ...l, active: true });
  // Free goats used up.
  if (l.free) return <>
    <PanelSection title="Goats">
      <PanelSectionRow><Field label="Your free goats are used up" description="Start the 7-day free trial of a yearly plan at controlcult.com for 8 more goats, then enter the code it gives you here." /></PanelSectionRow>
    </PanelSection>
    <LicenseSection onUnlocked={done} />
  </>;
  return <><FreeSection onUnlocked={done} /><LicenseSection onUnlocked={done} /></>;
}

// Free goats without leaving the Deck: the email gets a link that unlocks this Deck when it's opened,
// so only a real inbox counts. The panel watches for the unlock.
function FreeSection({ onUnlocked }: { onUnlocked: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; full?: boolean } | null>(null);
  useEffect(() => {
    if (!note?.ok) return;
    const t = setInterval(() => local("GET", "/license").then(x => { if (x?.active) onUnlocked(); }).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [note?.ok]);
  const send = async () => {
    setBusy(true); setNote(null);
    const r = await local("POST", "/free", { email: email.trim() }).catch(() => ({ error: "Control Cult isn't answering." }));
    setBusy(false);
    setNote(r?.sent ? { ok: true, text: `Sent to ${email.trim()}. Open the email and tap Unlock, on any device (your phone is fine). This Deck unlocks by itself.` } : { ok: false, text: r?.error || "It didn't send.", full: /all given out|already had its free goats/.test(r?.error || "") });
  };
  return (
    <PanelSection title="Free goats">
      <PanelSectionRow><Field label="No license yet" description="Get your free goats here, no card needed: enter your email and tap the link we send you." /></PanelSectionRow>
      <PanelSectionRow><TextField label="Your email" value={email} onChange={e => setEmail(e.target.value)} /></PanelSectionRow>
      <PanelSectionRow><ButtonItem layout="below" disabled={busy || !email.trim()} onClick={send}>{busy ? "Sending…" : note?.ok ? "Send again" : "Send my free goats"}</ButtonItem></PanelSectionRow>
      {note ? <PanelSectionRow><Field label={note.ok ? "Check your email" : note.full ? "No free goats right now" : "Not sent"} description={note.text} /></PanelSectionRow> : null}
    </PanelSection>
  );
}

function LicenseSection({ onUnlocked }: { onUnlocked?: () => void } = {}) {
  const [l, setL] = useState<{ line?: string; canEnter?: boolean; error?: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { local("GET", "/license").then(setL).catch(() => setL({ error: "Control Cult isn't answering." })); }, []);
  const redeem = async () => {
    setBusy(true); setNote(null);
    const r = await local("POST", "/license", { code: code.trim() }).catch(() => ({ error: "Control Cult isn't answering." }));
    setBusy(false);
    if (r?.error) { setNote({ ok: false, text: r.error }); return; }
    setL(r); setCode(""); setNote({ ok: true, text: "Control Cult is unlocked." }); onUnlocked?.();
  };
  return (
    <PanelSection title="License">
      <PanelSectionRow><Field label={l?.line || (l?.error ? "License: couldn't check it" : "License: checking…")} description={l?.line ? undefined : l?.error} /></PanelSectionRow>
      {l?.canEnter !== false ? <>
        <PanelSectionRow><TextField label="Enter license code" description="It looks like CC-XXXX-XXXX-XXXX. Capitals and dashes don't matter." value={code} onChange={e => setCode(e.target.value)} /></PanelSectionRow>
        <PanelSectionRow><ButtonItem layout="below" disabled={busy || !code.trim()} onClick={redeem}>{busy ? "Checking…" : "Unlock"}</ButtonItem></PanelSectionRow>
        {note ? <PanelSectionRow><Field label={note.ok ? "Done" : "Code not accepted"} description={note.text} /></PanelSectionRow> : null}
      </> : null}
    </PanelSection>
  );
}

function SettingsPage() {
  useEffect(ownScreen, []);
  const [s, setS] = useState<Settings | null>(null);
  const [usage, setUsage] = useState<any>(null);
  const [testers, setTesters] = useState<any>(null);
  const [invite, setInvite] = useState<{ name: string; result?: any }>({ name: "" });
  const [pair, setPair] = useState<any>(null);
  const [msg, setMsg] = useState("");
  const [client, setClient] = useState<any>(null);
  useEffect(() => { const t = setInterval(() => local("GET", "/client").then(setClient).catch(() => {}), 3000); local("GET", "/client").then(setClient).catch(() => {}); return () => clearInterval(t); }, []);
  const load = async () => {
    setS(await local("GET", "/settings").catch(() => ({ error: "Control Cult isn't answering." })));
    const u = await local("GET", "/usage").catch(() => null);
    setUsage(u);
    if (u?.owner) setTesters(await local("GET", "/testers").catch(() => null));
  };
  useEffect(() => { load(); }, []);
  // The wake word's first start downloads its listener: the line under the switch follows it until it's ready.
  useEffect(() => { if (!s?.enabled || !s.wakeWord || !["off", "starting", "error"].includes(s.wakeState || "")) return; const t = setTimeout(() => local("GET", "/settings").then(setS).catch(() => {}), 3000); return () => clearTimeout(t); }, [s]);
  const set = async (b: any) => { const r = await local("POST", "/settings", b); setMsg(r?.notes?.length ? r.notes.join("; ") : r?.error || ""); setS(await local("GET", "/settings")); };
  const money = (v: number) => `$${(v || 0).toFixed(2)}`;
  const devOpts = (list: Device[]) => [{ data: "default", label: "System default" }, ...list.map(d => ({ data: d.id, label: d.name + (d.default ? " (default)" : "") }))];

  return (
    <div style={{ marginTop: "40px", height: "calc(100% - 40px)", overflowY: "scroll", padding: "0 24px 40px" }}>
      <h2 style={{ margin: "16px 0 4px" }}>Control Cult settings</h2>
      {s?.error ? <Field label="Not reachable" description={s.error} /> : null}
      {msg ? <Field label="Note" description={msg} /> : null}

      <LicenseSection />

      <PanelSection title="Solo voice (talk on the Deck, no phone)">
        <PanelSectionRow><ToggleField label="Solo voice" description="Your Control Cult hotkeys work while this is on." checked={!!s?.enabled} onChange={v => set({ enabled: v })} /></PanelSectionRow>
        <PanelSectionRow><ToggleField label="Wake word" description={`Say “Oh great one”, wait for the chime, then talk. It sends when you stop, and nothing leaves the Deck until it hears the phrase. “Stop” or “shut up” cuts off a reply.${s?.wakeWord ? ` ${s?.wakeText || ""}` : ""}`} checked={!!s?.wakeWord} disabled={!s?.enabled} onChange={v => set({ wakeWord: v })} /></PanelSectionRow>
        <PanelSectionRow><DropdownItem label="Voice" description={`${(s?.voices || []).find(o => o.id === (s?.voice || "relay"))?.about || ""} The same voices as the phone app's menu; the phone's own voice has no Deck version.${s?.voiceNote ? ` ${s.voiceNote}` : ""}`} rgOptions={(s?.voices?.length ? s.voices : [{ id: "relay", name: "Relay (OpenAI)", about: "" }]).map(o => ({ data: o.id, label: o.name }))} selectedOption={s?.voice || "relay"} disabled={!s?.enabled} onChange={o => set({ voice: o.data })} /></PanelSectionRow>
        <PanelSectionRow><DropdownItem label="Microphone" rgOptions={devOpts(s?.mics || [])} selectedOption={s?.mic || "default"} onChange={o => set({ mic: o.data })} /></PanelSectionRow>
        <PanelSectionRow><DropdownItem label="Speaker" rgOptions={devOpts(s?.speakers || [])} selectedOption={s?.speaker || "default"} onChange={o => set({ speaker: o.data })} /></PanelSectionRow>
        <PanelSectionRow><DropdownItem label="Speech speed" rgOptions={(s?.speeds || [1.25]).map(v => ({ data: v, label: `${v}×` }))} selectedOption={s?.speed || 1.25} onChange={o => set({ speed: o.data })} /></PanelSectionRow>
        {s?.audioError ? <PanelSectionRow><Field label="Audio devices" description={s.audioError} /></PanelSectionRow> : null}
      </PanelSection>

      <PanelSection title="Hotkeys">
        <PanelSectionRow><Field label="Talk" description={s?.hotkeys.talk || "Not set. Ask Noob Deity for a talk button."} /></PanelSectionRow>
        {s?.hotkeys.talk ? <PanelSectionRow><ButtonItem layout="below" onClick={() => set({ clearHotkey: "talk" })}>Turn off the talk hotkey</ButtonItem></PanelSectionRow> : null}
        <PanelSectionRow><Field label="Feedback" description={s?.hotkeys.feedback || "Not set. Ask Noob Deity for a feedback hotkey."} /></PanelSectionRow>
        {s?.hotkeys.feedback ? <PanelSectionRow><ButtonItem layout="below" onClick={() => set({ clearHotkey: "feedback" })}>Turn off the feedback hotkey</ButtonItem></PanelSectionRow> : null}
        <PanelSectionRow><Field label="Hide widgets" description={s?.hotkeys.hide ? `${s.hotkeys.hide}: takes every widget off the screen, and brings them back.` : "Not set. Ask Noob Deity for a hotkey that hides and shows all widgets."} /></PanelSectionRow>
        {s?.hotkeys.hide ? <PanelSectionRow><ButtonItem layout="below" onClick={() => set({ clearHotkey: "hide" })}>Turn off the hide widgets hotkey</ButtonItem></PanelSectionRow> : null}
        <PanelSectionRow><Field label="Changing them" description="Noob Deity picks hotkeys for your controller and layout: ask it, for example “put talk on a back button”." /></PanelSectionRow>
      </PanelSection>

      <PanelSection title="Widgets">
        {Object.keys(WIDGET_NAMES).map(k => (
          <div key={k}>
            <PanelSectionRow><ToggleField label={WIDGET_NAMES[k]} description="Shows in the drawer and in the widget editor. 📌 in the editor keeps it over the game; 🧲 there snaps widgets while you arrange them." checked={!!s?.widgets?.[k]?.on} onChange={v => set({ widget: { key: k, on: v } })} /></PanelSectionRow>
          </div>
        ))}
        <PanelSectionRow><DropdownItem label="Controller widget style" description={`${(s?.cvStyles || []).find(o => o.id === (s?.cvStyle || "controller"))?.about || ""} 🎨 in the overlay's editor switches it too.`.trim()} rgOptions={(s?.cvStyles?.length ? s.cvStyles : [{ id: "controller", name: "Controller", about: "" }]).map(o => ({ data: o.id, label: o.name }))} selectedOption={s?.cvStyle || "controller"} onChange={o => set({ cvStyle: o.data })} /></PanelSectionRow>
        <PanelSectionRow><ToggleField label="Widget drawer" description="Swipe down from the top edge of the screen to show your widgets over the game, swipe up to hide them. ✏️ in the drawer opens the editor." checked={!!s?.drawerEnabled} onChange={v => set({ drawerEnabled: v })} /></PanelSectionRow>
        {s?.drawerEnabled ? <PanelSectionRow><ToggleField label="Keep handle always visible" description="A thin handle stays at the top of the screen while the drawer is shut, so you can see where to pull. Off: it shows only while the drawer is open." checked={!!s?.drawerHandle} onChange={v => set({ drawerHandle: v })} /></PanelSectionRow> : null}
        <PanelSectionRow><ButtonItem layout="below" onClick={() => { Navigation.NavigateBack(); setTimeout(() => local("POST", "/overlay"), 400); }}>Edit my widgets</ButtonItem></PanelSectionRow>
      </PanelSection>

      <PanelSection title="Control Cult app in your library">
        <PanelSectionRow><Field label="The app" description={client?.text || "The phone app in its own window: launch it from your library next to a game and switch with the Steam button."} /></PanelSectionRow>
        <PanelSectionRow><ButtonItem layout="below" disabled={!!client?.running} onClick={async () => { setClient(await local("POST", "/client")); }}>{client?.step === "done" ? "Add it again" : client?.running ? "Adding…" : "Add Control Cult to my library"}</ButtonItem></PanelSectionRow>
      </PanelSection>

      <PanelSection title="Your phone">
        <PanelSectionRow><ButtonItem layout="below" onClick={async () => setPair(await local("POST", "/pair"))}>Pair a phone</ButtonItem></PanelSectionRow>
        {pair?.error ? <PanelSectionRow><Field label="Couldn't get a code" description={pair.error} /></PanelSectionRow> : null}
        {pair?.code ? (
          <PanelSectionRow>
            <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
              <img src={dataUrl(qrSvg(pair.url))} style={{ width: "150px", height: "150px", background: "#fff", borderRadius: "8px" }} />
              <div><div style={{ fontSize: "22px", letterSpacing: "3px", fontFamily: "monospace" }}>{pair.code}</div><div style={{ fontSize: "13px", opacity: 0.7 }}>Scan with your phone's camera, or type the code into the Control Cult app.</div></div>
            </div>
          </PanelSectionRow>
        ) : null}
      </PanelSection>

      {usage?.owner ? (
        <PanelSection title="Usage today">
          <PanelSectionRow><Field label="Assistant" description={`${money(usage.ai)} of ${money(usage.aiCap)}`} /></PanelSectionRow>
          <PanelSectionRow><Field label="Voice" description={`${money(usage.voice)} of ${money(usage.voiceCap)}`} /></PanelSectionRow>
          {(testers?.rows || []).slice(0, 12).map((t: any, i: number) => <PanelSectionRow key={i}><Field label={`${t.tester || "Tester"}${t.owner ? " (you)" : ""}`} description={`Today ${money(t.today?.usd)} · this week ${money(t.week?.usd)}`} /></PanelSectionRow>)}
        </PanelSection>
      ) : null}

      {usage?.owner ? (
        <PanelSection title="Invite a tester">
          <PanelSectionRow><TextField label="Their name" value={invite.name} onChange={e => setInvite({ name: e.target.value })} /></PanelSectionRow>
          <PanelSectionRow><ButtonItem layout="below" disabled={!invite.name.trim()} onClick={async () => setInvite({ ...invite, result: await local("POST", "/invite", { name: invite.name.trim() }) })}>Make an invite code</ButtonItem></PanelSectionRow>
          {invite.result?.error ? <PanelSectionRow><Field label="Couldn't make one" description={invite.result.error} /></PanelSectionRow> : null}
          {invite.result?.code ? (
            <PanelSectionRow>
              <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
                <img src={dataUrl(qrSvg(invite.result.download))} style={{ width: "140px", height: "140px", background: "#fff", borderRadius: "8px" }} />
                <div><div style={{ fontSize: "22px", letterSpacing: "3px", fontFamily: "monospace" }}>{invite.result.code}</div><div style={{ fontSize: "13px", opacity: 0.7 }}>Send them this code. The QR opens the download page: {invite.result.download}</div></div>
              </div>
            </PanelSectionRow>
          ) : null}
        </PanelSection>
      ) : null}

    </div>
  );
}

// ---- Quick Access panel ----------------------------------------------------------------------------------------------
function Content() {
  const [s, setS] = useState<Status | null>(null);
  const [pair, setPair] = useState<{ code?: string; url?: string; error?: string } | null>(null);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    let alive = true;
    const tick = () => status().then(x => { if (alive) setS(x); }).catch(() => {});
    tick();
    const t = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (s && !s.installed) return <InstallPanel />;
  const game = s?.game?.name || (s?.game?.appid ? `App ${s.game.appid}` : null);
  return (
    <>
      <UnlockSection />
      <PanelSection title="Status">
        <PanelSectionRow><Field label="Control Cult" description={!s ? "Checking…" : s.noStatus ? "Updating to the version this panel needs (within 30 minutes; restarting the Deck is quicker)" : s.connected ? `Connected${s.tester ? ` as ${s.tester}` : ""}` : "Not connected yet (is the Deck online?)"} /></PanelSectionRow>
        <PanelSectionRow><Field label="Game" description={game || "No game running"} /></PanelSectionRow>
        {s?.controller ? <PanelSectionRow><Field label="Controller" description={s.controller} /></PanelSectionRow> : null}
        {s?.layout ? <PanelSectionRow><Field label="Layout" description={s.layout} /></PanelSectionRow> : null}
        {s?.steamOk === false ? <PanelSectionRow><Field label="Steam" description="Control Cult can't reach Steam yet. Ask Noob Deity on your phone to restart Steam." /></PanelSectionRow> : null}
      </PanelSection>
      <PanelSection title="Control Cult">
        <PanelSectionRow><ButtonItem layout="below" onClick={() => local("POST", "/overlay")}>Edit my widgets</ButtonItem></PanelSectionRow>
        <PanelSectionRow><ButtonItem layout="below" onClick={() => { Navigation.Navigate(ROUTE); Navigation.CloseSideMenus(); }}>Settings</ButtonItem></PanelSectionRow>
        <PanelSectionRow><ButtonItem layout="below" disabled={busy === "uninstall"} onClick={async () => { if (busy !== "confirm") { setBusy("confirm"); return; } setBusy("uninstall"); await uninstall().catch(() => {}); }}>{busy === "confirm" ? "Press again to remove Control Cult (your Steam layouts stay)" : busy === "uninstall" ? "Removing Control Cult…" : "Uninstall Control Cult"}</ButtonItem></PanelSectionRow>
      </PanelSection>
      <PanelSection title="Your phone">
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy === "pair"} onClick={async () => { setBusy("pair"); setPair(await pairing().catch(() => ({ error: "Couldn't get a code." }))); setBusy(""); }}>
            {busy === "pair" ? "Getting a code…" : "Connect a phone"}
          </ButtonItem>
        </PanelSectionRow>
        {pair?.error ? <PanelSectionRow><Field label="Couldn't get a code" description={pair.error} /></PanelSectionRow> : null}
        {pair?.code && pair.url ? (
          <PanelSectionRow>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", width: "100%" }}>
              <img src={dataUrl(qrSvg(pair.url))} style={{ width: "180px", height: "180px", background: "#fff", borderRadius: "8px" }} />
              <div style={{ fontSize: "20px", letterSpacing: "3px", fontFamily: "monospace" }}>{pair.code}</div>
              <div style={{ fontSize: "12px", opacity: 0.7, textAlign: "center" }}>Scan with your phone's camera, or type the code into the Control Cult app.</div>
            </div>
          </PanelSectionRow>
        ) : null}
      </PanelSection>
    </>
  );
}

export default definePlugin(() => {
  // The first update under the new name: Decky can't replace a plugin whose name changed, so it unpacks this one
  // over the old folder and leaves the old "NoobDeity" loaded until it restarts. Unload that one first (it takes its
  // route and widgets layer with it, so this comes before adding ours), or both show in Decky's list.
  try { (window as any).DeckyPluginLoader?.unloadPlugin?.("NoobDeity"); } catch {}
  routerHook.addRoute(ROUTE, SettingsPage, { exact: true });
  routerHook.addGlobalComponent("NoobDeityPinned", PinnedLayer);
  ndlog("info", `plugin ${VERSION} loaded`);
  (window as any).__noobdeity = { openMainMenu: () => Navigation.OpenMainMenu(), openQuickAccess: () => Navigation.OpenQuickAccessMenu(999 as any), closeQuickAccess: () => Navigation.CloseSideMenus(), poke: () => poke() };
  return {
    name: "Control Cult",
    titleView: <div className={staticClasses.Title}>Control Cult</div>,
    content: <Content />,
    icon: <svg width="1em" height="1em" viewBox="0 0 512 512"><path fill="currentColor" fillRule="evenodd" d="M256 24C336 66 382 140 390 236C394 282 398 316 412 344C454 362 484 396 494 440L500 498H12L18 440C28 396 58 362 100 344C114 316 118 282 122 236C130 140 176 66 256 24ZM256 126C318 162 348 222 348 290C348 360 310 404 256 404C202 404 164 360 164 290C164 222 194 162 256 126Z" /><path fill="currentColor" d="M230 200h52v62h62v52h-62v62h-52v-62h-62v-52h62z" /></svg>,
    onDismount() {
      routerHook.removeRoute(ROUTE);
      routerHook.removeGlobalComponent("NoobDeityPinned");
      delete (window as any).__noobdeity;
    },
  };
});
