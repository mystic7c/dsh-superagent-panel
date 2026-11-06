/* Panel stylesheet rendered into the panel subtree. Every color is a Harness theme token (`--dsw-alias-*`); sizing
   comes from the `--sa-*` scale below (5 font sizes, 7 spacing steps, 4 radii — contract §2). No literal colors, no
   off-scale sizes: if a value is not in the scale it belongs in a control height or a border width. */

const PANEL_CSS = `

/* Scale tokens. Defined on the page (and on the two surfaces that can render outside it: the crash fallback and the
   toast), so every component below resolves them through inheritance. --sa-line is the single border-color alias. */
.sa-page, .sa-main, .sa-toast {
  --sa-fs-caption: 11px;
  --sa-fs-meta: 12px;
  --sa-fs-body: 13px;
  --sa-fs-title: 15px;
  --sa-fs-page: 20px;
  --sa-sp-2: 2px;
  --sa-sp-4: 4px;
  --sa-sp-8: 8px;
  --sa-sp-12: 12px;
  --sa-sp-16: 16px;
  --sa-sp-24: 24px;
  --sa-sp-32: 32px;
  --sa-r-sm: 4px;
  --sa-r-md: 8px;
  --sa-r-lg: 12px;
  --sa-r-pill: 999px;
  --sa-line: var(--dsw-alias-border-l2);
  --sa-focus: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  /* Text-only tokens raised to WCAG AA on the panel's light surfaces: the theme's tertiary label is 3.71:1 and its
     link colour 4.23:1 on white, so meta text and links mix in a little of the primary label. Shape/fill uses of the
     raw tokens (idle dots, load-bar segments) are left alone. */
  --sa-label-tertiary: color-mix(in srgb, var(--dsw-alias-label-tertiary) 76%, var(--dsw-alias-label-primary));
  --sa-link-text: color-mix(in srgb, var(--dsw-alias-link, var(--dsw-alias-brand-primary)) 82%, var(--dsw-alias-label-primary));
  /* State text is mixed with the primary label so it reaches AA on tinted/white surfaces in the light theme. */
  --sa-danger-text: color-mix(in srgb, var(--dsw-alias-state-error-primary) 72%, var(--dsw-alias-label-primary));
  --sa-warn-text: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, var(--dsw-alias-label-primary));
  --sa-success-text: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, var(--dsw-alias-label-primary));
  --sa-info-text: color-mix(in srgb, var(--dsw-alias-brand-primary) 70%, var(--dsw-alias-label-primary));
}

/* ---------- page frame ---------- */
.sa-page { box-sizing: border-box; height: 100%; overflow: hidden;
  container-type: inline-size; background: var(--dsw-alias-bg-base, transparent); color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: var(--sa-fs-body); line-height: 1.5; }
.sa-page > .sa-column { box-sizing: border-box; width: 100%; max-width: 1180px; margin: 0 auto; height: 100%;
  min-height: 0; padding: 0 var(--sa-sp-32); display: flex; flex-direction: column; gap: 0; }
/* Permanent chrome: title/status row + six tabs. It never scrolls; only the scroll body below it does. */
.sa-topbar { position: relative; z-index: 4; flex: 0 0 auto; display: flex; flex-direction: column;
  gap: var(--sa-sp-24); padding-top: var(--sa-sp-32); background: var(--dsw-alias-bg-base, transparent); }
.sa-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; scroll-padding: 64px 0 72px;
  padding: 0 0 var(--sa-sp-32); }
.sa-main { display: flex; flex-direction: column; gap: var(--sa-sp-24); min-width: 0; min-height: 320px;
  padding-top: var(--sa-sp-24); }
.sa-section { display: flex; flex-direction: column; gap: var(--sa-sp-8); min-width: 0; }
.sa-section { scroll-margin-top: 80px; }
.sa-detail-nav { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; flex-wrap: wrap;
  gap: var(--sa-sp-2) var(--sa-sp-4); padding: var(--sa-sp-4) 0; background: var(--dsw-alias-bg-base, transparent);
  border-bottom: 0.5px solid var(--sa-line); }
.sa-detail-jump { border: 0; background: transparent; color: var(--sa-link-text); font: inherit;
  font-size: var(--sa-fs-meta); line-height: 1.4; padding: var(--sa-sp-4) var(--sa-sp-8); border-radius: var(--sa-r-pill);
  cursor: pointer; }
.sa-detail-jump:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.sa-detail-jump[data-active='true'] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2);
  font-weight: 600; }
.sa-detail-context { display: flex; align-items: center; gap: var(--sa-sp-8); min-width: 0; max-width: 44%; }
.sa-detail-context-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--sa-fs-body); line-height: 1.4; font-weight: 600; color: var(--dsw-alias-label-primary); }
.sa-detail-jumps { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sa-sp-2); }
.sa-detail-context-action { display: flex; align-items: center; gap: var(--sa-sp-8); margin-left: auto; flex: none; }
.sa-detail-jump:focus-visible { outline: var(--sa-focus); outline-offset: -2px; }
.sa-hint { margin: 0; font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.sa-error { margin: 0; font-size: var(--sa-fs-body); line-height: 1.5; color: var(--sa-danger-text); overflow-wrap: anywhere; white-space: pre-wrap; }
.sa-banner { margin: 0; padding: var(--sa-sp-8) var(--sa-sp-12); border-radius: var(--sa-r-md); font-size: var(--sa-fs-body);
  line-height: 1.5; overflow-wrap: anywhere; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); }
.sa-banner.sa-danger { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.sa-actions { display: flex; align-items: center; gap: var(--sa-sp-8); flex-wrap: wrap; }
.sa-filters { display: flex; align-items: center; gap: var(--sa-sp-8) var(--sa-sp-12); flex-wrap: wrap; }

/* ---------- page head / global status ---------- */
.sa-head { position: relative; z-index: 3; display: flex; align-items: flex-start; justify-content: space-between;
  gap: var(--sa-sp-8) var(--sa-sp-16); flex-wrap: wrap; }
.sa-head-title { min-width: 0; display: flex; align-items: baseline; gap: var(--sa-sp-12); flex-wrap: wrap; }
.sa-title { margin: 0; font-size: var(--sa-fs-page); line-height: 1.3; font-weight: 600; color: var(--dsw-alias-label-primary); }
.sa-head-actions, .sa-header-actions, .sa-head-tools { display: flex; align-items: center; gap: var(--sa-sp-8); flex-wrap: wrap; }
.sa-global-status { display: inline-flex; align-items: center; gap: var(--sa-sp-4); font-size: var(--sa-fs-meta);
  line-height: 1.4; color: var(--sa-label-tertiary); font-variant-numeric: tabular-nums; }
.sa-global-status .sa-status-icon { flex: none; }
.sa-status-pending { color: var(--sa-warn-text); font-weight: 600; }

/* ---------- primary tabs (underline) ---------- */
.sa-tabs { display: flex; width: 100%; gap: var(--sa-sp-24); overflow-x: auto; padding: 0; border-bottom: 0.5px solid var(--sa-line); }
.sa-tab { flex: none; box-sizing: border-box; height: 36px; padding: 0 var(--sa-sp-2); border: 0;
  border-bottom: 2px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: var(--sa-fs-body); line-height: 1.5; font-weight: 500; white-space: nowrap; cursor: pointer; }
.sa-tab:hover { color: var(--dsw-alias-label-primary); }
.sa-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
.sa-tab:focus-visible { outline: var(--sa-focus); outline-offset: 2px; border-radius: var(--sa-r-sm); }

/* ---------- section header ---------- */
.sa-section-title { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--sa-sp-8);
  font-size: var(--sa-fs-title); line-height: 1.35; font-weight: 600; color: var(--dsw-alias-label-primary); }
.sa-section-name { min-width: 0; }
.sa-section-icon { display: inline-flex; color: var(--sa-label-tertiary); }
.sa-section-action { margin-left: auto; display: inline-flex; align-items: center; gap: var(--sa-sp-8); flex-wrap: wrap; }
.sa-count { font-size: var(--sa-fs-meta); line-height: 1.4; font-weight: 400; color: var(--sa-label-tertiary);
  font-variant-numeric: tabular-nums; }
/* A non-zero count is an answer, a zero is noise: only >0 gets the body size/weight (critique #8/#24). */
.sa-count:not([data-empty='true']) { font-size: var(--sa-fs-body); font-weight: 500; color: var(--dsw-alias-label-secondary); }
.sa-badge { display: inline-flex; align-items: center; padding: 0 var(--sa-sp-8); border: 0.5px solid var(--sa-line);
  border-radius: var(--sa-r-pill); font-size: var(--sa-fs-caption); line-height: 1.6; color: var(--sa-label-tertiary); }

/* ---------- buttons / icon buttons ---------- */
.sa-btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--sa-sp-4); border: none;
  border-radius: var(--sa-r-sm); background: transparent; padding: 0 var(--sa-sp-12); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: var(--sa-fs-body); line-height: 1; font-weight: 500; white-space: nowrap; cursor: pointer; }
.sa-btn:disabled { cursor: not-allowed; opacity: 0.4; }
.sa-btn:focus-visible { outline: var(--sa-focus); outline-offset: 2px; }
.sa-btn-md { height: 32px; }
.sa-btn-sm { height: 28px; padding: 0 var(--sa-sp-8); font-size: var(--sa-fs-meta); }
.sa-btn-primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color: var(--dsw-alias-label-primary-foreground); }
.sa-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); }
.sa-btn-outline { border: 0.5px solid var(--sa-line); }
.sa-btn-ghost:hover:not(:disabled), .sa-btn-outline:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.sa-btn-danger { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary-foreground); }
.sa-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 85%, var(--dsw-alias-label-primary)); }
.sa-btn-icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; }
.sa-icon-btn { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 28px; height: 28px;
  padding: 0; border: none; border-radius: var(--sa-r-sm); background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; }
.sa-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); }
.sa-icon-btn:focus-visible { outline: var(--sa-focus); outline-offset: 1px; }
.sa-icon-btn:disabled { cursor: not-allowed; opacity: 0.4; }
.sa-icon-btn[data-variant='outline'] { border: 0.5px solid var(--sa-line); border-radius: var(--sa-r-md);
  background: transparent; }
.sa-icon-btn[data-variant='outline']:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.sa-copy-btn { color: var(--dsw-alias-label-secondary); }
.sa-menu { position: relative; display: inline-flex; flex: none; }
.sa-menu-pop { position: absolute; top: calc(100% + var(--sa-sp-4)); z-index: 40; min-width: 184px; max-width: 320px;
  padding: var(--sa-sp-4); display: flex; flex-direction: column; gap: var(--sa-sp-2);
  border: 0.5px solid var(--sa-line); border-radius: var(--sa-r-md); background: var(--dsw-alias-bg-overlay);
  box-shadow: var(--dsw-elevation-prominent); }
.sa-menu-pop[data-align='end'] { right: 0; }
/* An open row menu must escape the row's stacking context: later rows paint their action buttons above it otherwise. */
.sa-row:has(.sa-menu-pop) { z-index: 60; }
.sa-row-buttons:has(.sa-menu-pop) { z-index: 60; }
.sa-menu-pop[data-align='start'] { left: 0; }
.sa-menu-item { display: flex; align-items: center; gap: var(--sa-sp-8); width: 100%; min-height: 32px;
  padding: var(--sa-sp-4) var(--sa-sp-8); border: 0; border-radius: var(--sa-r-sm); background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: var(--sa-fs-body); line-height: 1.4; text-align: left;
  white-space: nowrap; cursor: pointer; }
.sa-menu-item:hover:not(:disabled), .sa-menu-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); outline: none; }
.sa-menu-item:disabled { color: var(--sa-label-tertiary); cursor: not-allowed; }
.sa-menu-trigger[aria-expanded='true'] { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); }
.sa-menu-item-icon { display: inline-flex; flex: none; color: var(--dsw-alias-menu-icon, var(--dsw-alias-label-secondary)); }

/* ---------- tags / pills / segmented ---------- */
.sa-tag { display: inline-flex; align-items: center; border-radius: var(--sa-r-pill); padding: 0 var(--sa-sp-8);
  font-size: var(--sa-fs-caption); line-height: 1.6; font-weight: 500; white-space: nowrap; }
.sa-tag[data-tone='outline'] { border: 0.5px solid var(--sa-line); color: var(--sa-label-tertiary); }
.sa-tag[data-tone='neutral'] { background: var(--dsw-alias-bg-layer-2, transparent); color: var(--dsw-alias-label-secondary); }
.sa-tag[data-tone='quiet'] { color: var(--sa-label-tertiary); }
.sa-tag[data-tone='success'] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); color: var(--sa-success-text); }
.sa-tag[data-tone='info'] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); color: var(--sa-info-text); }
.sa-tag[data-tone='warning'] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); color: var(--sa-warn-text); }
.sa-tag[data-tone='danger'] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--sa-danger-text); }
.sa-pill { display: inline-flex; align-items: center; gap: var(--sa-sp-4); height: 24px; padding: 0 var(--sa-sp-8);
  border: none; border-radius: var(--sa-r-pill); background: var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: var(--sa-fs-meta); line-height: 1.4; cursor: pointer; }
.sa-pill:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.sa-pill:focus-visible { outline: var(--sa-focus); outline-offset: 2px; }
.sa-pill-active, .sa-pill-active:hover { color: var(--dsw-alias-label-primary); box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary); }
.sa-segmented { width: 100%; max-width: 480px; box-sizing: border-box; display: inline-grid;
  grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: var(--sa-sp-2); padding: var(--sa-sp-2);
  border-radius: var(--sa-r-pill); background: var(--dsw-alias-bg-layer-2, transparent); }
.sa-segment { height: 28px; padding: 0 var(--sa-sp-12); border: 0; border-radius: var(--sa-r-pill); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: var(--sa-fs-body); line-height: 1.5; font-weight: 500;
  white-space: nowrap; cursor: pointer; }
.sa-segment:hover:not(:disabled), .sa-segment[aria-checked='true'] { color: var(--dsw-alias-label-primary); }
.sa-segment[aria-checked='true'] { background: var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1)); box-shadow: var(--dsw-elevation-soft, 0 1px 2px transparent); }
.sa-segment:focus-visible { outline: var(--sa-focus); outline-offset: -2px; }
.sa-segment:disabled { cursor: default; opacity: 0.4; }

/* ---------- shape-coded status ---------- */
.sa-status-icon { flex: none; display: inline-block; vertical-align: -2px; }
.sa-status-icon[data-state='done'] { color: var(--dsw-alias-state-success-primary); }
.sa-status-icon[data-state='ongoing'] { color: var(--dsw-alias-brand-primary); }
.sa-status-icon[data-state='warning'] { color: var(--dsw-alias-state-warn-primary); }
.sa-status-icon[data-state='error'] { color: var(--dsw-alias-state-error-primary); }
.sa-status-icon[data-state='idle'] { color: var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-tertiary)); }
.sa-status-icon[data-state='queued'] { color: var(--sa-label-tertiary); }
.sa-status-text { display: inline-flex; align-items: center; gap: var(--sa-sp-4); font-size: var(--sa-fs-meta);
  line-height: 1.4; color: var(--dsw-alias-label-secondary); min-width: 0; }
.sa-status-label { min-width: 0; overflow-wrap: anywhere; }
.sa-spin { animation: sa-spin 1s linear infinite; transform-origin: 50% 50%; }

/* ---------- list rows (tickets, threads, decisions) ---------- */
.sa-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sa-sp-2); }
.sa-row { position: relative; min-width: 0; border-radius: var(--sa-r-md); padding: var(--sa-sp-8) 0;
  display: flex; flex-wrap: wrap; gap: var(--sa-sp-4) var(--sa-sp-12); align-items: flex-start; }
.sa-row + .sa-row { border-top: 0.5px solid var(--sa-line); border-top-left-radius: 0; border-top-right-radius: 0; }
.sa-row.sa-link:hover, .sa-row-openable:hover, .sa-row[role='button']:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.sa-row-openable, .sa-row[role='button'] { cursor: pointer; }
/* Search results are real <button> rows; strip the platform button chrome so they read like every other .sa-row. */
button.sa-row { width: 100%; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; }
.sa-row[role='button']:focus-visible { outline: var(--sa-focus); outline-offset: -2px; }
/* The whole-row affordance is mouse-only; keyboard opens through this title button, which is a sibling of the row's
   action buttons (no interactive element nested inside another). */
.sa-row-open { flex: 1 1 auto; min-width: 0; min-height: 24px; display: flex; align-items: center; padding: 0;
  border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.sa-row-open > span { display: block; }
.sa-row-open:focus-visible { outline: var(--sa-focus); outline-offset: -2px; border-radius: var(--sa-r-sm); }
.sa-row-main { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: var(--sa-sp-4); }
.sa-row-title { display: flex; align-items: center; gap: var(--sa-sp-8); min-width: 0; font-size: var(--sa-fs-title);
  line-height: 1.35; font-weight: 500; }
.sa-row-title > span, .sa-row-title > a { min-width: 0; }
.sa-row-meta { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sa-sp-2) var(--sa-sp-8); color: var(--dsw-alias-label-secondary);
  font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.sa-row-quote { font-size: var(--sa-fs-body); line-height: 1.5; color: var(--dsw-alias-label-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-row-actions { position: relative; z-index: 1; display: flex; align-items: center; gap: var(--sa-sp-4); flex: none;
  margin-left: auto; font-size: var(--sa-fs-meta); line-height: 1.4; }
.sa-row-buttons { position: relative; z-index: 1; display: inline-flex; align-items: center; gap: var(--sa-sp-8); flex: none; flex-wrap: nowrap; }
/* ---------- execution ledger (round 4): status | ticket | evidence | actions ---------- */
.sa-row-evidence { display: none; min-width: 0; align-items: center; justify-content: flex-start;
  font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sa-row-evidence .sa-inline-link { font-size: var(--sa-fs-meta); }
.sa-exec-queue .sa-row { display: grid; grid-template-columns: 16px minmax(0, 1fr) 300px max-content;
  column-gap: var(--sa-sp-12); align-items: center; }
.sa-exec-queue .sa-row .sa-row-main { grid-column: 2; min-width: 0; }
.sa-exec-queue .sa-row-evidence { grid-column: 3; display: flex; }
.sa-exec-queue .sa-row-actions { grid-column: 4; margin-left: 0; }
.sa-queue-head { display: grid; grid-template-columns: 16px minmax(0, 1fr) 300px max-content;
  column-gap: var(--sa-sp-12); align-items: center; padding: 0 0 var(--sa-sp-4);
  font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--sa-label-tertiary); }
.sa-queue-head > :nth-child(2) { grid-column: 2; }
.sa-queue-head > :nth-child(3) { grid-column: 3; }
.sa-queue-head > :nth-child(4) { grid-column: 4; text-align: right; }
/* Execution's six stage filters can exceed the shared 480px cap; only this wide variant lifts it. */
.sa-segmented-wide { max-width: none; }
/* The evidence rail is the first thing to go when the container is too narrow for four tracks; the cause remains a
   meta chip through the row's other content and the whole row still reads as one line. */
@container (max-width: 860px) {
  .sa-exec-queue .sa-row { display: flex; flex-wrap: wrap; align-items: flex-start; }
  .sa-exec-queue .sa-row-actions { order: 2; margin-left: auto; }
  /* Keep the cause/MR visible: it becomes a full-width third line instead of being deleted with the column. */
  .sa-exec-queue .sa-row-evidence { display: flex; order: 3; flex: 1 1 100%; padding-left: 28px;
    white-space: normal; overflow: visible; text-overflow: clip; color: var(--dsw-alias-label-secondary); }
  .sa-queue-head { display: none; }
}
.sa-row-meta .sa-btn, .sa-row-meta .sa-icon-btn, .sa-row-meta button, .sa-row-meta a { position: relative; z-index: 1; }
.sa-open { max-width: 100%; padding: 0; border: 0; background: transparent; color: inherit; font: inherit;
  font-size: var(--sa-fs-title); line-height: 1.35; font-weight: 500; text-align: left; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-open::after { content: ''; position: absolute; inset: 0; border-radius: var(--sa-r-md); }
.sa-open:focus-visible { outline: none; }
.sa-open:focus-visible::after { outline: var(--sa-focus); outline-offset: 2px; }
.sa-ticket { display: flex; gap: var(--sa-sp-12); align-items: flex-start; }
.sa-ticket-body { flex: 1 1 220px; min-width: 0; }
.sa-ticket > .sa-ticket-body { display: flex; flex-direction: column; gap: var(--sa-sp-4); }
.sa-ticket .sa-row, .sa-row-openable, .sa-row[role='button'] { min-height: 44px; }
.sa-inline-link { position: relative; z-index: 1; color: var(--sa-link-text); text-decoration: none; }
.sa-inline-link:hover { text-decoration: underline; }
.sa-inline-link:focus-visible { outline: var(--sa-focus); outline-offset: 2px; border-radius: var(--sa-r-sm); }
.sa-textlink { padding: 0; border: 0; background: none; font: inherit; font-size: var(--sa-fs-meta);
  color: var(--sa-link-text); cursor: pointer; text-align: left; }
.sa-textlink:hover { text-decoration: underline; }
.sa-textlink:focus-visible { outline: var(--sa-focus); outline-offset: 2px; border-radius: var(--sa-r-sm); }
.sa-more { align-self: flex-start; }

/* ---------- keys/values, stats, funnel, load bar ---------- */
.sa-kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--sa-sp-4) var(--sa-sp-16); margin: 0; }
.sa-kv dt { font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--dsw-alias-label-secondary); }
.sa-kv dd { margin: 0; min-width: 0; font-size: var(--sa-fs-body); line-height: 1.5; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.sa-stats { display: flex; flex-wrap: wrap; gap: var(--sa-sp-12) var(--sa-sp-24); padding: var(--sa-sp-4) 0; }
.sa-stat { display: flex; flex-direction: column; gap: var(--sa-sp-2); min-width: 88px; }
.sa-stat-label { font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--sa-label-tertiary); }
.sa-stat-value { font-size: var(--sa-fs-page); line-height: 1.3; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.sa-funnel { display: flex; flex-direction: column; gap: var(--sa-sp-4); min-width: 0; }
.sa-funnel-steps { display: flex; align-items: flex-start; flex-wrap: wrap; gap: var(--sa-sp-8); min-width: 0; }
.sa-funnel-step { display: flex; flex-direction: column; gap: var(--sa-sp-2); min-width: 68px; }
.sa-funnel-value { font-size: var(--sa-fs-page); line-height: 1.3; font-weight: 600; font-variant-numeric: tabular-nums; }
.sa-funnel-label { font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--sa-label-tertiary); }
.sa-funnel-arrow { flex: none; display: inline-flex; align-items: center; height: calc(var(--sa-fs-page) * 1.3);
  color: var(--sa-label-tertiary); font-size: var(--sa-fs-body); line-height: 1; }
.sa-funnel-summary { margin: 0; font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--dsw-alias-label-secondary); }
.sa-funnel-foot { flex-basis: 100%; font-size: var(--sa-fs-caption); line-height: 1.4; color: var(--sa-label-tertiary); }
.sa-executor-load { display: flex; flex-direction: column; gap: var(--sa-sp-8); min-width: 0; }
.sa-executor-band { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sa-sp-8) var(--sa-sp-24);
  flex-wrap: wrap; min-width: 0; }
.sa-executor-load-col { flex: 1 1 360px; min-width: 0; }
.sa-executor-recent { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; margin-left: auto;
  gap: var(--sa-sp-4) var(--sa-sp-8); flex: 0 1 auto; font-size: var(--sa-fs-meta); line-height: 1.4;
  color: var(--dsw-alias-label-secondary); }
.sa-loadbar { display: flex; flex-direction: column; gap: var(--sa-sp-4); min-width: 0; }
.sa-loadbar-track { box-sizing: border-box; width: 100%; max-width: 100%; height: 8px; border-radius: var(--sa-r-pill);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-border-l2)); overflow: hidden; }
.sa-loadbar-fill { height: 100%; border-radius: inherit; background: var(--dsw-alias-brand-primary); }
.sa-loadbar-fill[data-tone='warning'] { background: var(--dsw-alias-state-warn-primary); }
.sa-loadbar-fill[data-tone='error'] { background: var(--dsw-alias-state-error-primary); }
.sa-loadbar-fill[data-tone='idle'] { background: var(--dsw-alias-label-tertiary); }
.sa-loadbar-meta { display: flex; align-items: center; gap: var(--sa-sp-4) var(--sa-sp-12); flex-wrap: wrap;
  font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--dsw-alias-label-secondary); }

/* ---------- cards ---------- */
.sa-card-row { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sa-sp-8) var(--sa-sp-16); flex-wrap: wrap; }
.sa-card-row-main { flex: 1 1 320px; min-width: 0; }

.sa-card { display: flex; flex-direction: column; gap: var(--sa-sp-12); min-width: 0; padding: var(--sa-sp-16);
  border: 0.5px solid var(--sa-line); border-radius: var(--sa-r-md);
  background: var(--dsw-alias-bg-layer-1, transparent); }
.sa-card-head { display: flex; align-items: center; gap: var(--sa-sp-8); min-height: 28px; flex-wrap: wrap; }
.sa-card-title { min-width: 0; font-size: var(--sa-fs-title); line-height: 1.35; font-weight: 600; }
.sa-cards { display: flex; flex-direction: column; gap: var(--sa-sp-8); }
/* Source page: one section per category, two cards per row so a short card no longer leaves a long empty band. */
.sa-source-groups { display: flex; flex-direction: column; gap: var(--sa-sp-16); min-width: 0; }
.sa-cards-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sa-sp-12);
  align-items: start; min-width: 0; }
@media (max-width: 760px) { .sa-cards-2 { grid-template-columns: minmax(0, 1fr); } }
/* A source group with a single card should use the row, not leave its right half empty. */
.sa-cards-2:has(> :only-child) { grid-template-columns: minmax(0, 1fr); }
.sa-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--sa-sp-12); min-width: 0; }
.sa-grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sa-sp-12); }

/* ---------- two-column content blocks (overview: 24h funnel + executor) ---------- */
.sa-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--sa-sp-24); align-items: start; }

/* ---------- panes (trigger: list + detail; settings: nav + form) ---------- */
.sa-panes { display: grid; grid-template-columns: minmax(240px, 320px) minmax(0, 1fr); gap: var(--sa-sp-24); align-items: start; min-width: 0; }
.sa-pane { min-width: 0; display: flex; flex-direction: column; gap: var(--sa-sp-8); }
.sa-pane-aside { min-width: 0; display: flex; flex-direction: column; gap: var(--sa-sp-8); align-self: start;
  position: sticky; top: 0; max-height: calc(100vh - 160px); overflow-y: auto; }
.sa-settings { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: var(--sa-sp-24); align-items: start; min-width: 0; }
.sa-settings-nav { display: flex; flex-direction: column; gap: var(--sa-sp-2); min-width: 0; }
/* Content group inside the settings body: one concept's fields, vertical rhythm (used by 60-settings). */
.sa-settings-group { display: flex; flex-direction: column; gap: var(--sa-sp-16); min-width: 0; }
/* The nav re-uses the name for its row buttons; the descendant selector keeps both meanings (critique §18). */
.sa-settings-nav .sa-settings-group { display: flex; flex-direction: row; align-items: center; gap: var(--sa-sp-8); width: 100%;
  min-height: 36px; padding: var(--sa-sp-8) var(--sa-sp-12); border: 0; border-left: 2px solid transparent; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: var(--sa-fs-body); line-height: 1.5; text-align: left; cursor: pointer; }
.sa-settings-nav .sa-settings-group:hover { color: var(--dsw-alias-label-primary); }
.sa-settings-nav .sa-settings-group[aria-current='true'] { color: var(--dsw-alias-label-primary);
  font-weight: 600; border-left-color: var(--dsw-alias-brand-primary); }
.sa-settings-nav .sa-settings-group:focus-visible { outline: var(--sa-focus); outline-offset: -2px; }
/* Reference-only groups (evaluation catalog, prompt brief) sit below a divider in the settings rail: the navigation
   promises what can be changed first, and keeps read-only context reachable. */
.sa-settings-nav-sep { margin: var(--sa-sp-8) var(--sa-sp-12) var(--sa-sp-4); border-top: 0.5px solid var(--sa-line); }
.sa-settings-nav-label { padding: 0 var(--sa-sp-12); font-size: var(--sa-fs-caption); line-height: 1.6;
  color: var(--sa-label-tertiary); }
.sa-settings-nav .sa-settings-group[data-reference='true'] { color: var(--dsw-alias-label-secondary); font-size: var(--sa-fs-meta); }
.sa-settings-nav .sa-settings-group[data-reference='true'][aria-current='true'] {
  border-left-color: var(--sa-label-tertiary); }
.sa-settings-body { min-width: 0; max-width: 760px; display: flex; flex-direction: column; gap: var(--sa-sp-24); }

/* ---------- forms ---------- */
.sa-form { display: flex; flex-direction: column; gap: var(--sa-sp-24); min-width: 0; }
.sa-field { display: flex; flex-direction: column; gap: var(--sa-sp-4); font-size: var(--sa-fs-body); line-height: 1.5; min-width: 0; }
.sa-field-head { display: inline-flex; align-items: center; gap: var(--sa-sp-4); color: var(--dsw-alias-label-secondary); }
.sa-field small { color: var(--sa-label-tertiary); font-size: var(--sa-fs-meta); }
.sa-switch-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sa-sp-16); min-height: 36px; font-size: var(--sa-fs-body); }
.sa-switch-row-text { min-width: 0; display: flex; flex-direction: column; gap: var(--sa-sp-2); }
.sa-input { box-sizing: border-box; display: inline-flex; align-items: center; gap: var(--sa-sp-4); height: 32px; min-width: 0;
  padding: 0 var(--sa-sp-8); border: 0.5px solid var(--sa-line); border-radius: var(--sa-r-sm);
  background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary); }
.sa-input:hover { border-color: var(--dsw-alias-border-l3, var(--sa-line)); }
.sa-input:focus-within { border-color: var(--dsw-alias-brand-primary); }
.sa-input-full { width: 100%; }
.sa-input input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: var(--sa-fs-body); }
.sa-input-icon { display: inline-flex; color: var(--sa-label-tertiary); }
.sa-select { box-sizing: border-box; width: 100%; min-width: 0; height: 32px; padding: 0 var(--sa-sp-8);
  border: 0.5px solid var(--sa-line); border-radius: var(--sa-r-sm); font: inherit; font-size: var(--sa-fs-body);
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1, transparent); }
.sa-select:focus-visible { outline: var(--sa-focus); outline-offset: 1px; }
.sa-textarea { box-sizing: border-box; width: 100%; min-width: 0; border: 0.5px solid var(--sa-line);
  border-radius: var(--sa-r-sm); padding: var(--sa-sp-8) var(--sa-sp-12); font: inherit; font-size: var(--sa-fs-body);
  line-height: 1.5; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1, transparent); resize: vertical; }
.sa-textarea:focus-visible { outline: var(--sa-focus); outline-offset: 1px; }
.sa-switch { position: relative; flex: none; width: 36px; height: 20px; padding: 0; border: 0; border-radius: var(--sa-r-pill);
  cursor: pointer; background: var(--dsw-alias-border-l2); transition: background 140ms ease; }
.sa-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.sa-switch:focus-visible { outline: var(--sa-focus); outline-offset: 2px; }
.sa-switch:disabled { cursor: not-allowed; opacity: 0.4; }
.sa-switch-thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground); transition: left 140ms ease; }
.sa-switch[aria-checked='true'] .sa-switch-thumb { left: 18px; }

/* ---------- empty / error / skeleton ---------- */
.sa-empty { display: flex; align-items: flex-start; flex-wrap: wrap; gap: var(--sa-sp-12); padding: var(--sa-sp-16); }
/* A grey dashed box reads as "placeholder/broken"; a positive state is a sentence, not a box (critique #14). */
.sa-empty-icon { display: inline-flex; color: var(--dsw-alias-label-secondary); }
.sa-empty[data-state='done'] .sa-empty-icon { color: var(--dsw-alias-state-success-primary); }
.sa-empty-body { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: var(--sa-sp-2); }
.sa-empty-title { margin: 0; font-size: var(--sa-fs-body); line-height: 1.5; font-weight: 500; color: var(--dsw-alias-label-primary); }
.sa-empty-hint { margin: 0; font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--sa-label-tertiary); overflow-wrap: anywhere; }
.sa-empty-action { margin-left: auto; }
.sa-error-state { display: flex; align-items: flex-start; gap: var(--sa-sp-12); padding: var(--sa-sp-16);
  border-radius: var(--sa-r-md); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.sa-error-state-body { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: var(--sa-sp-4); }
.sa-error-state-title { margin: 0; font-size: var(--sa-fs-body); line-height: 1.5; font-weight: 500; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.sa-error-state-hint { margin: 0; font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--dsw-alias-label-secondary); }
.sa-skeleton { display: flex; flex-direction: column; gap: var(--sa-sp-8); padding: var(--sa-sp-8) 0; }
.sa-skeleton-line { height: 12px; border-radius: var(--sa-r-sm); background: var(--dsw-alias-bg-skeleton, var(--dsw-alias-bg-layer-2)); }
.sa-skeleton-title { height: 16px; }
.sa-skeleton-block { height: 72px; border-radius: var(--sa-r-md); background: var(--dsw-alias-bg-skeleton, var(--dsw-alias-bg-layer-2)); }

/* ---------- save bar ---------- */
.sa-savebar { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; justify-content: flex-end;
  gap: var(--sa-sp-8); flex-wrap: wrap; padding: var(--sa-sp-12) 0; background: var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1));
  border-top: 0.5px solid var(--sa-line); }
.sa-savebar-text { margin-right: auto; font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--dsw-alias-label-secondary); }
.sa-savebar[data-state='error'] .sa-savebar-text { color: var(--dsw-alias-state-error-primary); }
.sa-savebar-actions { display: flex; align-items: center; gap: var(--sa-sp-8); flex-wrap: wrap; }
.sa-card > .sa-savebar { margin: 0 calc(-1 * var(--sa-sp-16)) calc(-1 * var(--sa-sp-16)); padding: var(--sa-sp-12) var(--sa-sp-16); }

/* ---------- raw values / folded / code ---------- */
.sa-raw { display: flex; flex-direction: column; gap: var(--sa-sp-8); min-width: 0; padding: var(--sa-sp-8) var(--sa-sp-12);
  border: 0.5px solid var(--sa-line); border-radius: var(--sa-r-md); }
.sa-raw-head { display: flex; align-items: center; gap: var(--sa-sp-8); flex-wrap: wrap; min-width: 0; }
.sa-raw-label { flex: none; font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--sa-label-tertiary); }
.sa-raw-preview { flex: 1 1 120px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-raw-body { max-height: 320px; }
.sa-folded { min-width: 0; }
.sa-folded-summary { display: flex; align-items: center; gap: var(--sa-sp-4); cursor: pointer; list-style: none;
  font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--dsw-alias-label-secondary); }
.sa-folded-summary::-webkit-details-marker { display: none; }
.sa-folded-summary:focus-visible { outline: var(--sa-focus); outline-offset: 2px; border-radius: var(--sa-r-sm); }
.sa-folded[open] > .sa-folded-summary .sa-status-icon, .sa-folded[open] > .sa-folded-summary svg { transform: rotate(90deg); }
.sa-folded-body { display: flex; flex-direction: column; gap: var(--sa-sp-8); padding: var(--sa-sp-8) 0 var(--sa-sp-4) var(--sa-sp-16); min-width: 0; }
.sa-mono { font-family: var(--ds-font-family-code, Menlo, monospace); font-size: var(--sa-fs-meta); line-height: 1.4; overflow-wrap: anywhere; }
.sa-code { font-family: var(--ds-font-family-code, Menlo, monospace); font-size: var(--sa-fs-meta); padding: 0 var(--sa-sp-4);
  border-radius: var(--sa-r-sm); background: var(--dsw-alias-bg-layer-2, transparent); }
.sa-pre { margin: 0; padding: var(--sa-sp-12); border-radius: var(--sa-r-md); background: var(--dsw-alias-bg-layer-2, transparent);
  font-family: var(--ds-font-family-code, Menlo, monospace); font-size: var(--sa-fs-meta); line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 480px; overflow: auto; }
.sa-pre ins { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent); text-decoration: none; }
.sa-pre del { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent); text-decoration: none; }

/* ---------- markdown / text ---------- */
.sa-md { display: flex; flex-direction: column; gap: var(--sa-sp-4); font-size: var(--sa-fs-body); line-height: 1.5; overflow-wrap: anywhere; }
.sa-md p, .sa-md ul, .sa-md ol { margin: 0; }
.sa-md ul, .sa-md ol { padding-left: var(--sa-sp-24); }
.sa-md ul { list-style: disc outside; }
.sa-md ol { list-style: decimal outside; }
.sa-md li { margin: 0 0 var(--sa-sp-2); }
.sa-md li:last-child { margin-bottom: 0; }
.sa-md-heading { font-weight: 600; }
.sa-event-text { margin: 0; font-size: var(--sa-fs-body); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.sa-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px; }
.sa-clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.sa-clamp-2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sa-clamp-3 { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.sa-clamp-5 { display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
.sa-clamp-10 { display: -webkit-box; -webkit-line-clamp: 10; -webkit-box-orient: vertical; overflow: hidden; }
.sa-clamp-4 { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.sa-clamp-6 { display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; }
.sa-clamp-8 { display: -webkit-box; -webkit-line-clamp: 8; -webkit-box-orient: vertical; overflow: hidden; }
.sa-hint + .sa-md { color: var(--dsw-alias-label-secondary); }

/* ---------- detail page head ---------- */
.sa-page-head { display: flex; flex-direction: column; gap: var(--sa-sp-4); min-width: 0; }
.sa-page-head-top { display: flex; align-items: center; }
.sa-page-head-top > .sa-btn { margin-left: calc(-1 * var(--sa-sp-8)); }
.sa-page-head-main { display: flex; align-items: center; gap: var(--sa-sp-8) var(--sa-sp-16); flex-wrap: wrap; width: 100%; }
.sa-page-head-title { margin: 0; flex: 1 1 auto; min-width: 0; font-size: var(--sa-fs-page); line-height: 1.3; font-weight: 600; overflow-wrap: anywhere; }
.sa-page-head-actions { display: flex; align-items: center; gap: var(--sa-sp-8); flex-wrap: wrap; flex: none; }
.sa-page-head-meta { display: flex; align-items: center; gap: var(--sa-sp-4) var(--sa-sp-12); flex-wrap: wrap;
  font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }

/* ---------- disclosure ---------- */
.sa-disclosure { display: flex; flex-direction: column; gap: var(--sa-sp-2); min-width: 0; }
.sa-disclosure-row { display: flex; align-items: center; gap: var(--sa-sp-8); padding: var(--sa-sp-4) 0; cursor: pointer;
  min-height: 28px; border-radius: var(--sa-r-sm); }
.sa-disclosure-row:focus-visible { outline: var(--sa-focus); outline-offset: 2px; }
.sa-disclosure-lead { display: inline-flex; align-items: center; gap: var(--sa-sp-4); color: var(--sa-label-tertiary); }
.sa-disclosure-icon, .sa-disclosure-chevron { display: inline-flex; align-items: center; }
.sa-disclosure-title { min-width: 0; font-size: var(--sa-fs-body); line-height: 1.5; }
.sa-disclosure-body { padding: var(--sa-sp-4) 0 var(--sa-sp-8) var(--sa-sp-24); display: flex; flex-direction: column; gap: var(--sa-sp-8); }
.sa-details { display: flex; flex-direction: column; gap: var(--sa-sp-2); border-top: 0.5px solid var(--sa-line); padding-top: var(--sa-sp-8); }

/* ---------- timeline / rail / gates ---------- */
.sa-timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.sa-event { padding: var(--sa-sp-12) 0; border-bottom: 0.5px solid var(--sa-line); display: flex; flex-direction: column;
  gap: var(--sa-sp-4); min-width: 0; }
.sa-event:last-child { border-bottom: 0; }
.sa-event.sa-highlight { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  border-radius: var(--sa-r-md); padding-inline: var(--sa-sp-8); margin-inline: calc(-1 * var(--sa-sp-8)); }
.sa-event-actor { font-weight: 500; color: var(--dsw-alias-label-secondary); }
.sa-event-quiet .sa-event-text { color: var(--sa-label-tertiary); }
.sa-event-foot { display: flex; align-items: center; gap: var(--sa-sp-8); flex-wrap: wrap; font-size: var(--sa-fs-meta);
  line-height: 1.4; color: var(--sa-label-tertiary); }
.sa-rail { display: flex; align-items: flex-start; flex-wrap: wrap; gap: var(--sa-sp-8); min-width: 0; }
.sa-rail-step { display: flex; flex-direction: column; gap: var(--sa-sp-4); min-width: 76px; flex: 1 1 76px; }
.sa-rail-dot { display: inline-flex; align-items: center; gap: var(--sa-sp-4); min-height: 16px; }
.sa-rail-label { font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--dsw-alias-label-secondary); }
.sa-rail-step[data-state='done'] .sa-rail-label { color: var(--dsw-alias-label-secondary); }
.sa-rail-step[data-state='ongoing'] .sa-rail-label { color: var(--dsw-alias-label-primary); font-weight: 600; }
.sa-rail-step[data-state='error'] .sa-rail-label { color: var(--sa-danger-text); }
.sa-rail-step[data-state='warning'] .sa-rail-label { color: var(--sa-warn-text); }
.sa-rail-result { font-size: var(--sa-fs-caption); line-height: 1.4; color: var(--dsw-alias-label-secondary);
  overflow-wrap: normal; word-break: keep-all; }
.sa-gates { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sa-sp-2) var(--sa-sp-12);
  font-size: var(--sa-fs-meta); line-height: 1.4; }
.sa-gate { display: inline-flex; align-items: center; gap: var(--sa-sp-4); }
.sa-rules { list-style: none; margin: 0; padding: 0; border-top: 0.5px solid var(--sa-line); }
.sa-rule { display: flex; align-items: flex-start; gap: var(--sa-sp-12); padding: var(--sa-sp-8) 0; border-bottom: 0.5px solid var(--sa-line); }
.sa-rule > :first-child { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sa-sp-2); }
.sa-rule-title { font-size: var(--sa-fs-body); line-height: 1.5; font-weight: 500; }
.sa-rule-preview { font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--sa-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-rule-body { display: flex; flex-direction: column; gap: var(--sa-sp-8); padding: var(--sa-sp-4) 0 var(--sa-sp-8); }
.sa-rule-switch { margin-top: var(--sa-sp-2); flex: none; }

/* ---------- legend / glossary ---------- */
.sa-legend-title { margin: var(--sa-sp-16) 0 var(--sa-sp-4); font-size: var(--sa-fs-body); font-weight: 600; color: var(--dsw-alias-label-primary); }
.sa-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--sa-sp-4) var(--sa-sp-16); }
.sa-legend li { display: flex; align-items: center; gap: var(--sa-sp-4); }
.sa-glossary-modal { width: min(760px, 100%); }
.sa-glossary-section { display: flex; flex-direction: column; gap: var(--sa-sp-8); margin-top: var(--sa-sp-16); min-width: 0; }
.sa-glossary-section:first-child { margin-top: 0; }
.sa-glossary-heading { margin: 0; font-size: var(--sa-fs-title); line-height: 1.35; font-weight: 600; }
.sa-glossary { width: 100%; border-collapse: collapse; font-size: var(--sa-fs-body); line-height: 1.5; }
.sa-glossary th, .sa-glossary td { text-align: left; padding: var(--sa-sp-4) var(--sa-sp-8); border-bottom: 0.5px solid var(--sa-line); vertical-align: top; }
.sa-glossary thead th { font-size: var(--sa-fs-meta); font-weight: 400; color: var(--sa-label-tertiary); }
.sa-glossary tbody th, .sa-glossary tbody td { overflow-wrap: anywhere; }
.sa-glossary .sa-glossary-group th { font-weight: 600; color: var(--dsw-alias-label-secondary); padding-top: var(--sa-sp-12); }
.sa-glossary-values { display: flex; gap: var(--sa-sp-8); align-items: baseline; flex-wrap: wrap; }
.sa-glossary-values-label { font-size: var(--sa-fs-meta); color: var(--sa-label-tertiary); min-width: 72px; }
.sa-glossary-values-list { display: flex; flex-wrap: wrap; gap: var(--sa-sp-4); }

/* ---------- modal / tooltip / toast ---------- */
.sa-modal-root { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: var(--sa-sp-24); }
.sa-modal-mask { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1, color-mix(in srgb, var(--dsw-alias-bg-base) 45%, transparent)); }
.sa-modal { position: relative; width: min(560px, 100%); max-height: min(80vh, 720px); overflow: auto;
  border-radius: var(--sa-r-lg); padding: var(--sa-sp-16) var(--sa-sp-24) var(--sa-sp-16); background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-elevation-prominent); animation: sa-modal-in 120ms ease-out; }
.sa-modal:focus { outline: none; }
.sa-modal-header { display: flex; align-items: center; justify-content: space-between; gap: var(--sa-sp-12); }
.sa-modal-header h2 { margin: 0; font-size: var(--sa-fs-title); line-height: 1.35; font-weight: 600; }
.sa-modal-close { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0;
  border: 0; border-radius: var(--sa-r-sm); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.sa-modal-close:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.sa-modal-close:focus-visible { outline: var(--sa-focus); outline-offset: 1px; }
.sa-modal-description { margin: var(--sa-sp-8) 0 0; font-size: var(--sa-fs-body); line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.sa-modal-body { margin-top: var(--sa-sp-12); }
.sa-modal-footer { margin-top: var(--sa-sp-16); display: flex; justify-content: flex-end; gap: var(--sa-sp-8); flex-wrap: wrap; }
.sa-toast { position: fixed; left: 50%; bottom: var(--sa-sp-24, 24px); transform: translateX(-50%); z-index: 1200;
  max-width: min(560px, calc(100vw - var(--sa-sp-32, 32px) * 2)); padding: var(--sa-sp-8, 8px) var(--sa-sp-16, 16px);
  border-radius: var(--sa-r-md, 8px); background: var(--dsw-alias-toast-bg, var(--dsw-alias-bg-overlay));
  color: var(--dsw-alias-label-primary-foreground); box-shadow: var(--dsw-elevation-prominent);
  font-size: var(--sa-fs-body, 13px); line-height: 1.5; overflow-wrap: anywhere; }
.sa-info { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0;
  border: 0; background: none; color: var(--sa-label-tertiary); cursor: help; }
.sa-info:hover, .sa-info:focus-visible { color: var(--dsw-alias-label-secondary); }
.sa-info:focus-visible { outline: var(--sa-focus); outline-offset: 2px; border-radius: var(--sa-r-sm); }
.sa-info-warn { color: var(--dsw-alias-state-warn-primary); }
.sa-tooltip { position: fixed; z-index: 1100; width: max-content; max-width: min(320px, calc(100vw - var(--sa-sp-24, 24px)));
  padding: var(--sa-sp-4, 4px) var(--sa-sp-8, 8px); border-radius: var(--sa-r-sm, 4px);
  background: var(--dsw-alias-tooltip-bg, var(--dsw-alias-bg-overlay)); color: var(--dsw-alias-label-primary-foreground);
  font-size: var(--sa-fs-meta, 12px); line-height: 1.4; overflow-wrap: break-word; pointer-events: none;
  box-shadow: var(--dsw-elevation-prominent); }

/* Pulse/ledger key-values keep label and value on one line on medium widths: the generic .sa-kv stacks at 960,
   which turned the five-row pulse into a tall column of label/value pairs. */
.sa-kv.sa-kv-inline { grid-template-columns: max-content minmax(0, 1fr); }
@container (max-width: 600px) { .sa-kv.sa-kv-inline { grid-template-columns: minmax(0, 1fr); gap: var(--sa-sp-2); } }

/* ---------- overview shift brief (2026-11-06): two columns when the PANEL is >=960 wide, one below ---------- */
.sa-brief-grid { display: flex; flex-direction: column; gap: var(--sa-sp-24); min-width: 0; }
.sa-brief-col { display: flex; flex-direction: column; gap: var(--sa-sp-24); min-width: 0; }
/* Two columns when the PANEL is wide enough, not when the viewport is: the DSH sidebar/right rail decide the usable
   width, and a viewport breakpoint produced two ~300px columns at 1024–1180 with the sidebar open. */
@container (min-width: 960px) {
  .sa-brief-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: var(--sa-sp-32); align-items: start; }
}
/* 过滤 is a branch of 到达, not a funnel stage: it hangs under the step row as a quiet annotation. */
.sa-funnel-branch { align-self: center; font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--sa-label-tertiary);
  white-space: nowrap; }
.sa-ledger-title { margin: 0; font-size: var(--sa-fs-meta); line-height: 1.4; color: var(--dsw-alias-label-secondary); }
.sa-ledger { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sa-sp-4) var(--sa-sp-8); }
.sa-ledger .sa-tag { font-variant-numeric: tabular-nums; }

/* ---------- markdown fenced code (ticket bodies / worker reports) ---------- */
.sa-md-code { display: flex; flex-direction: column; min-width: 0; border: 0.5px solid var(--sa-line);
  border-radius: var(--sa-r-sm); background: var(--dsw-alias-bg-layer-2, transparent); }
.sa-md-code-head { display: flex; align-items: center; gap: var(--sa-sp-8); min-height: 28px;
  padding: 0 var(--sa-sp-8); border-bottom: 0.5px solid var(--sa-line); }
.sa-md-code-lang { flex: 1; min-width: 0; font-size: var(--sa-fs-caption); line-height: 1.4;
  color: var(--sa-label-tertiary); text-transform: lowercase; }
.sa-md-pre { margin: 0; padding: var(--sa-sp-8) var(--sa-sp-12); max-height: 320px; overflow: auto;
  font-family: var(--ds-font-family-code, Menlo, monospace); font-size: var(--sa-fs-meta); line-height: 1.5;
  white-space: pre; color: var(--dsw-alias-label-primary); }

/* ---------- settings group heading (each group's H2 mirrors its left-nav label) ---------- */
.sa-settings-title { margin: 0; font-size: var(--sa-fs-title); line-height: 1.35; font-weight: 600;
  color: var(--dsw-alias-label-primary); }

/* ---------- motion ---------- */
@keyframes sa-spin { to { transform: rotate(360deg); } }
@keyframes sa-modal-in { from { opacity: 0; transform: translateY(4px); } }
@media (prefers-reduced-motion: reduce) {
  .sa-spin, .sa-modal { animation: none; }
  .sa-switch, .sa-switch-thumb { transition: none; }
}

/* ---------- narrow (≤960 container): single column, tighter page padding ---------- */
@container (max-width: 960px) {
  .sa-page > .sa-column { padding: 0 var(--sa-sp-16); }
  .sa-topbar { padding-top: var(--sa-sp-32); gap: var(--sa-sp-16); }
  .sa-scroll { padding: 0 0 var(--sa-sp-16); }
  .sa-main { padding-top: var(--sa-sp-16); }
  .sa-panes, .sa-settings { grid-template-columns: minmax(0, 1fr); gap: var(--sa-sp-16); }
  .sa-pane-aside { position: static; max-height: none; overflow: visible; }
  .sa-card-grid { grid-template-columns: minmax(0, 1fr); }
  .sa-grid3 { grid-template-columns: minmax(0, 1fr); }
  .sa-kv { grid-template-columns: minmax(0, 1fr); gap: var(--sa-sp-2); }
  .sa-tabs { gap: var(--sa-sp-16); }
  .sa-page-head-title { font-size: var(--sa-fs-title); }
  .sa-row-actions { margin-left: 0; }
  .sa-empty-action { margin-left: 0; }
}
`
