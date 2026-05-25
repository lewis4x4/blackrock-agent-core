import React, { useState, useEffect } from "react";
import { Plus, Mic, Sparkles, ChevronDown, Cpu, ArrowUp } from "lucide-react";
import type { WorkspaceProps, ToolDef, TenantConfig } from "./types";
import { BrandHeader, BrandMark, Toast, type ToastState, hexA, themeVars } from "./theme";

/* The multi-model router. In production "Auto" is the planner picking a
 * model per subtask; here it is a selector so the concept is visible. */
const MODELS = [
  { id: "auto", label: "Auto", desc: "Best model picked per task" },
  { id: "opus", label: "Claude Opus", desc: "Deep reasoning + planning" },
  { id: "sonnet", label: "Claude Sonnet", desc: "Fast, balanced execution" },
  { id: "gpt", label: "GPT", desc: "Structured + code generation" },
];


const countConnected = (cfg: TenantConfig): number =>
  cfg.categories.reduce(
    (s, c) =>
      s +
      c.groups.reduce(
        (g, gr) => g + gr.tools.filter((t) => t.kind === "connected").length,
        0
      ),
    0
  );

/**
 * The Agent Core workspace shell. Knows nothing about any client — every
 * client-specific thing arrives in `config`. Embed it in any host app:
 *
 *   <Workspace config={qepConfig} onLaunch={...} onSend={...} />
 */
export function Workspace({ config, onLaunch, onSend }: WorkspaceProps) {
  const [activeNav, setActiveNav] = useState(config.nav[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [listening, setListening] = useState(false);
  const [model, setModel] = useState(MODELS[0]!);
  const [modelOpen, setModelOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2900);
    return () => clearTimeout(t);
  }, [toast]);

  const ac = config.accent;
  const hasText = query.trim().length > 0;
  const connected = countConnected(config);

  const launch = (tool: ToolDef) => {
    onLaunch?.(tool);
    setToast({
      id: Date.now(),
      msg: `Launching ${tool.name}`,
      sub:
        tool.kind === "connected"
          ? `Authenticating against ${tool.source} — client subscription`
          : `Agent Core · routing through ${model.label}`,
    });
  };

  const send = () => {
    if (!hasText) {
      setListening((v) => !v);
      return;
    }
    onSend?.(query, model.label);
    setToast({
      id: Date.now(),
      msg: "Request received",
      sub: `Planner is decomposing the task · ${model.label}`,
    });
    setQuery("");
  };

  return (
    <div
      className="ws"
      style={themeVars(ac)}
    >
      <style>{CSS}</style>
      <div className="glow" />

      {/* ---------------- nav rail ---------------- */}
      <aside className="rail">
        <div className="rail-mark" title="BlackRock AI · Agent Core">
          <BrandMark />
        </div>
        <button className="rail-new" onClick={() => launch({ name: "New session" } as ToolDef)}>
          <Plus size={20} strokeWidth={2.4} />
          <span>New</span>
        </button>
        <nav className="rail-nav">
          {config.nav.map((n, i) => {
            const on = n.id === activeNav;
            return (
              <button
                key={n.id}
                className={"rail-btn fu" + (on ? " on" : "")}
                style={{ animationDelay: `${0.04 * i + 0.05}s` }}
                onClick={() => setActiveNav(n.id)}
              >
                <span className="rail-ico">
                  <n.Icon size={19} strokeWidth={1.9} />
                </span>
                <span className="rail-label">{n.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="rail-avatar">{config.brand.charAt(0)}</div>
      </aside>

      {/* ---------------- main ---------------- */}
      <main className="main">
        <div className="hero">
          <BrandHeader config={config} />

          {/* composer */}
          <div
            className={"composer fu" + (focused ? " focused" : "")}
            style={{ animationDelay: ".20s" }}
          >
            <input
              className="composer-input"
              placeholder="Ask anything, create anything"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => e.key === "Enter" && send()}
            />
            <div className="composer-row">
              <div className="ctrl">
                <button
                  className="iconbtn"
                  title="Attach"
                  onClick={() => launch({ name: "Attachment" } as ToolDef)}
                >
                  <Plus size={17} strokeWidth={2.2} />
                </button>
                <div className="model-wrap">
                  <button className="modelpill" onClick={() => setModelOpen((v) => !v)}>
                    <Cpu size={14} strokeWidth={2} />
                    <span>{model.label}</span>
                    <ChevronDown size={13} strokeWidth={2.4} />
                  </button>
                  {modelOpen && (
                    <>
                      <div className="scrim" onClick={() => setModelOpen(false)} />
                      <div className="model-menu">
                        {MODELS.map((m) => (
                          <button
                            key={m.id}
                            className={"model-item" + (m.id === model.id ? " on" : "")}
                            onClick={() => {
                              setModel(m);
                              setModelOpen(false);
                            }}
                          >
                            <span className="model-name">{m.label}</span>
                            <span className="model-desc">{m.desc}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div className="ctrl">
                <button
                  className="iconbtn"
                  title="Voice"
                  onClick={() => setListening((v) => !v)}
                >
                  <Mic size={17} strokeWidth={2} />
                </button>
                <button
                  className={
                    "primary" + (hasText ? " send" : "") + (listening ? " live" : "")
                  }
                  onClick={send}
                >
                  {hasText ? (
                    <>
                      <ArrowUp size={16} strokeWidth={2.6} />
                      <span>Send</span>
                    </>
                  ) : (
                    <>
                      <span className="eq">
                        {[0, 1, 2, 3].map((i) => (
                          <span
                            key={i}
                            className={"eqbar" + (listening ? " on" : "")}
                            style={{ animationDelay: `${i * 0.12}s` }}
                          />
                        ))}
                      </span>
                      <span>{listening ? "Listening" : "Speak"}</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          <div className="metaline fu" style={{ animationDelay: ".26s" }}>
            <span className="meta-dot" /> {connected} connected subscriptions
            <span className="meta-sep" /> routing through {model.label}
            <span className="meta-sep" /> client owns the keys
          </div>
        </div>

        {/* launcher */}
        <div className="launch">
          {config.categories.map((cat, ci) => {
            const isOpen = !collapsed[cat.label];
            const total = cat.groups.reduce((s, g) => s + g.tools.length, 0);
            return (
              <section
                className="col fu"
                key={cat.label}
                style={{ animationDelay: `${0.3 + ci * 0.05}s` }}
              >
                <button
                  className="col-head"
                  onClick={() =>
                    setCollapsed((c) => ({ ...c, [cat.label]: !c[cat.label] }))
                  }
                >
                  <span className="col-title">{cat.label}</span>
                  <span className="col-count">{total}</span>
                  <ChevronDown
                    size={14}
                    strokeWidth={2.4}
                    className="col-chev"
                    style={{ transform: isOpen ? "none" : "rotate(-90deg)" }}
                  />
                </button>
                {isOpen && (
                  <div className="col-body">
                    {cat.groups.map((g, gi) => (
                      <div key={gi} className="group">
                        {g.label && <div className="group-label">{g.label}</div>}
                        {g.tools.map((tool) => (
                          <button
                            key={tool.name}
                            className="tile"
                            onClick={() => launch(tool)}
                          >
                            <span
                              className="tile-ico"
                              style={{
                                background: hexA(tool.tint, 0.14),
                                color: tool.tint,
                                boxShadow: `inset 0 0 0 1px ${hexA(tool.tint, 0.22)}`,
                              }}
                            >
                              <tool.Icon size={17} strokeWidth={1.9} />
                            </span>
                            <span className="tile-text">
                              <span className="tile-name">{tool.name}</span>
                              {tool.kind === "connected" && (
                                <span className="tile-source">{tool.source}</span>
                              )}
                            </span>
                            {tool.kind === "ai" && (
                              <span className="ai-tag">
                                <Sparkles size={11} strokeWidth={2.2} />
                              </span>
                            )}
                            {tool.kind === "connected" && (
                              <span className="conn-dot" title="Live connection" />
                            )}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        <footer className="foot">
          One shell. One codebase. Only the config changed.{" "}
          <strong>{config.brand}</strong> runs on Agent Core by BlackRock AI.
        </footer>
      </main>

      {toast && <Toast toast={toast} />}
    </div>
  );
}

/* The shell ships its own styling — the host app needs zero CSS setup. */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700&family=Hanken+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

.ws *{box-sizing:border-box;margin:0;padding:0;}
.ws{
  position:relative; display:flex; min-height:880px; width:100%;
  background:#0C0C0D; color:#ECECEE; overflow:hidden;
  font-family:'Hanken Grotesk',-apple-system,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.ws .glow{
  position:absolute; top:-340px; left:50%; transform:translateX(-50%);
  width:980px; height:680px; pointer-events:none;
  background:radial-gradient(ellipse at center, var(--acGlow), transparent 66%);
  opacity:.55; filter:blur(8px);
}
.ws .rail{
  position:relative; z-index:2; width:84px; flex-shrink:0;
  display:flex; flex-direction:column; align-items:center;
  padding:18px 0 16px; gap:6px;
  background:#0F0E0F; border-right:1px solid rgba(255,255,255,.06);
}
.ws .rail-mark{
  width:36px; height:36px; border-radius:10px; margin-bottom:14px;
  display:flex; align-items:center; justify-content:center;
  color:#0C0C0D; background:linear-gradient(150deg,#fff,#cfcfcf);
}
.ws .rail-new{
  display:flex; flex-direction:column; align-items:center; gap:3px;
  background:none; border:none; cursor:pointer; color:#9A9AA2;
  font-family:inherit; font-size:10.5px; padding:8px 0 12px;
  transition:color .15s;
}
.ws .rail-new:hover{color:#fff;}
.ws .rail-nav{display:flex; flex-direction:column; gap:3px; width:100%; align-items:center;}
.ws .rail-btn{
  width:60px; padding:9px 0 7px; border:none; background:none; cursor:pointer;
  display:flex; flex-direction:column; align-items:center; gap:4px;
  border-radius:13px; color:#76767E; font-family:inherit; font-size:10.5px;
  transition:color .15s, background .15s;
}
.ws .rail-btn:hover{color:#D6D6DA; background:rgba(255,255,255,.04);}
.ws .rail-btn .rail-ico{
  width:38px; height:34px; border-radius:11px;
  display:flex; align-items:center; justify-content:center;
  transition:background .15s, box-shadow .15s;
}
.ws .rail-btn.on{color:#fff;}
.ws .rail-btn.on .rail-ico{
  background:var(--acSoft); color:var(--ac);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);
}
.ws .rail-avatar{
  margin-top:auto; width:34px; height:34px; border-radius:50%;
  display:flex; align-items:center; justify-content:center;
  font-family:'Schibsted Grotesk',sans-serif; font-weight:600; font-size:14px;
  color:#cdcdd2; background:#222226; border:1px solid rgba(255,255,255,.08);
}
.ws .main{
  position:relative; z-index:1; flex:1; min-width:0;
  overflow-y:auto; padding:54px 48px 30px;
}
.ws .hero{max-width:880px; margin:0 auto; text-align:center;}
.ws .eyebrow{
  display:inline-flex; align-items:center; gap:7px;
  font-family:'JetBrains Mono',monospace; font-size:11px; letter-spacing:.16em;
  color:#7D7D86;
}
.ws .eyebrow-dot{
  width:6px; height:6px; border-radius:50%; background:var(--ac);
  box-shadow:0 0 9px var(--ac);
}
.ws .title{
  font-family:'Schibsted Grotesk',sans-serif; font-weight:600;
  font-size:43px; letter-spacing:-.02em; margin:16px 0 0; line-height:1.05;
}
.ws .subtitle{margin:11px 0 0; font-size:15px; color:#8C8C95;}
.ws .composer{
  margin-top:30px; text-align:left;
  background:#161618; border:1px solid rgba(255,255,255,.09);
  border-radius:20px; padding:6px 6px 6px 4px;
  transition:border-color .2s, box-shadow .2s;
}
.ws .composer.focused{
  border-color:var(--ac);
  box-shadow:0 0 0 4px var(--acSoft), 0 18px 50px -22px var(--acGlow);
}
.ws .composer-input{
  width:100%; background:none; border:none; outline:none;
  color:#ECECEE; font-family:inherit; font-size:16px;
  padding:18px 16px 12px;
}
.ws .composer-input::placeholder{color:#65656D;}
.ws .composer-row{
  display:flex; align-items:center; justify-content:space-between;
  padding:4px 6px 4px 8px;
}
.ws .ctrl{display:flex; align-items:center; gap:9px;}
.ws .iconbtn{
  width:36px; height:36px; border-radius:11px; cursor:pointer;
  display:flex; align-items:center; justify-content:center;
  background:none; border:1px solid rgba(255,255,255,.10); color:#9A9AA2;
  transition:color .15s, background .15s, border-color .15s;
}
.ws .iconbtn:hover{color:#fff; background:rgba(255,255,255,.05);}
.ws .model-wrap{position:relative;}
.ws .modelpill{
  display:flex; align-items:center; gap:7px; cursor:pointer;
  height:36px; padding:0 12px; border-radius:11px;
  background:none; border:1px solid rgba(255,255,255,.10);
  color:#C2C2C8; font-family:inherit; font-size:13px; font-weight:500;
  transition:color .15s, border-color .15s;
}
.ws .modelpill:hover{color:#fff; border-color:rgba(255,255,255,.2);}
.ws .scrim{position:fixed; inset:0; z-index:40;}
.ws .model-menu{
  position:absolute; bottom:46px; left:0; z-index:41; width:236px;
  background:#1B1B1E; border:1px solid rgba(255,255,255,.11);
  border-radius:14px; padding:6px; box-shadow:0 24px 50px -16px rgba(0,0,0,.7);
}
.ws .model-item{
  display:flex; flex-direction:column; gap:1px; width:100%; cursor:pointer;
  text-align:left; padding:9px 11px; border-radius:9px;
  background:none; border:none; font-family:inherit;
  transition:background .12s;
}
.ws .model-item:hover{background:rgba(255,255,255,.05);}
.ws .model-item.on{background:var(--acSoft);}
.ws .model-name{font-size:13px; font-weight:600; color:#EDEDF0;}
.ws .model-desc{font-size:11.5px; color:#84848C;}
.ws .primary{
  display:flex; align-items:center; gap:8px; cursor:pointer;
  height:38px; padding:0 16px; border-radius:12px; border:none;
  font-family:inherit; font-size:13.5px; font-weight:600;
  background:#F4F4F5; color:#161618;
  transition:transform .12s, background .15s, color .15s;
}
.ws .primary:hover{transform:translateY(-1px);}
.ws .primary.send{background:var(--ac); color:#0C0C0D;}
.ws .primary.live{background:var(--ac); color:#0C0C0D;}
.ws .eq{display:flex; align-items:flex-end; gap:2.5px; height:14px;}
.ws .eqbar{
  width:2.5px; height:6px; border-radius:2px;
  background:currentColor; transform-origin:bottom; opacity:.85;
}
.ws .eqbar.on{animation:eq .72s ease-in-out infinite;}
@keyframes eq{0%,100%{height:5px;}50%{height:14px;}}
.ws .metaline{
  margin-top:16px; display:flex; align-items:center; justify-content:center;
  gap:10px; flex-wrap:wrap;
  font-family:'JetBrains Mono',monospace; font-size:11px; color:#6F6F77;
}
.ws .meta-dot{
  width:6px; height:6px; border-radius:50%; background:#46B07E;
  box-shadow:0 0 8px rgba(70,176,126,.8);
}
.ws .meta-sep{width:3px; height:3px; border-radius:50%; background:#43434B;}
.ws .launch{
  max-width:1180px; margin:46px auto 0;
  display:grid; grid-template-columns:repeat(4,1fr); gap:12px;
}
.ws .col{
  background:rgba(255,255,255,.018); border:1px solid rgba(255,255,255,.055);
  border-radius:16px; padding:8px;
}
.ws .col-head{
  display:flex; align-items:center; gap:8px; width:100%; cursor:pointer;
  background:none; border:none; padding:8px 8px 7px; font-family:inherit;
}
.ws .col-title{
  font-family:'JetBrains Mono',monospace; font-size:11px; font-weight:500;
  letter-spacing:.13em; text-transform:uppercase; color:#9A9AA2;
}
.ws .col-count{
  font-size:10.5px; color:#65656D; background:rgba(255,255,255,.06);
  border-radius:6px; padding:1px 6px; font-family:'JetBrains Mono',monospace;
}
.ws .col-chev{margin-left:auto; color:#5C5C64; transition:transform .18s;}
.ws .col-body{display:flex; flex-direction:column; gap:3px;}
.ws .group{display:flex; flex-direction:column; gap:3px;}
.ws .group-label{
  font-family:'JetBrains Mono',monospace; font-size:9.5px; letter-spacing:.12em;
  text-transform:uppercase; color:#5E5E66; padding:7px 8px 3px;
}
.ws .tile{
  display:flex; align-items:center; gap:11px; width:100%; cursor:pointer;
  padding:9px 9px; border-radius:11px; text-align:left;
  background:none; border:1px solid transparent; font-family:inherit;
  transition:background .14s, border-color .14s, transform .14s;
}
.ws .tile:hover{
  background:rgba(255,255,255,.045);
  border-color:rgba(255,255,255,.09);
  transform:translateX(2px);
}
.ws .tile-ico{
  width:36px; height:36px; border-radius:10px; flex-shrink:0;
  display:flex; align-items:center; justify-content:center;
}
.ws .tile-text{display:flex; flex-direction:column; gap:1px; min-width:0;}
.ws .tile-name{font-size:13.5px; font-weight:600; color:#E4E4E8;}
.ws .tile-source{
  font-family:'JetBrains Mono',monospace; font-size:10px; color:#74747C;
}
.ws .ai-tag{
  margin-left:auto; flex-shrink:0; color:var(--ac);
  display:flex; align-items:center; justify-content:center;
  width:20px; height:20px; border-radius:6px; background:var(--acSoft);
}
.ws .conn-dot{
  margin-left:auto; flex-shrink:0; width:7px; height:7px; border-radius:50%;
  background:#46B07E; box-shadow:0 0 7px rgba(70,176,126,.85);
  animation:pulse 2.4s ease-in-out infinite;
}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.4;}}
.ws .foot{
  max-width:1180px; margin:26px auto 0; text-align:center;
  font-size:12.5px; color:#5E5E66;
}
.ws .foot strong{color:#9A9AA2; font-weight:600;}
.ws .toast{
  position:absolute; bottom:26px; left:50%; transform:translateX(-50%);
  z-index:50; display:flex; align-items:center; gap:12px;
  background:#1C1C1F; border:1px solid rgba(255,255,255,.11);
  border-radius:13px; padding:12px 16px;
  box-shadow:0 22px 48px -16px rgba(0,0,0,.75);
  animation:toastin .32s cubic-bezier(.2,.7,.2,1) both;
}
@keyframes toastin{from{opacity:0;transform:translate(-50%,14px);}to{opacity:1;transform:translate(-50%,0);}}
.ws .toast-dot{
  width:8px; height:8px; border-radius:50%; background:var(--ac);
  box-shadow:0 0 10px var(--ac); flex-shrink:0;
}
.ws .toast-text{display:flex; flex-direction:column; gap:1px;}
.ws .toast-text strong{font-size:13px; font-weight:600; color:#EDEDF0;}
.ws .toast-text span{font-size:11.5px; color:#86868E;}
.ws .fu{animation:fu .52s cubic-bezier(.2,.7,.2,1) both;}
@keyframes fu{from{opacity:0;transform:translateY(11px);}to{opacity:1;transform:translateY(0);}}
@media (max-width:1080px){
  .ws .launch{grid-template-columns:repeat(2,1fr);}
  .ws .main{padding:48px 28px 26px;}
}
@media (max-width:680px){
  .ws .launch{grid-template-columns:1fr;}
  .ws .title{font-size:32px;}
}
`;
