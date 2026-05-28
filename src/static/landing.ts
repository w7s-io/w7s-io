import { deployWorkflowHtml } from "./deployWorkflow";

export type DeployShowcaseTarget = {
  requestedUrl: string;
  deployUrl: string;
  repository: string;
  repositoryUrl: string;
  isOwnerRoot: boolean;
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const deployTargetHtml = (target?: DeployShowcaseTarget) => {
  if (!target) return "";

  const [owner = "owner"] = target.repository.split("/");
  const ownerBaseUrl = new URL(target.deployUrl);
  ownerBaseUrl.pathname = "/";
  ownerBaseUrl.search = "";
  ownerBaseUrl.hash = "";
  const ownerRootUrl = ownerBaseUrl.toString();
  const exampleRepoUrl = new URL("/repo-name/", ownerRootUrl).toString();
  const ownerRouteHint = `<p>W7S uses one subdomain per GitHub owner: <code>${escapeHtml(ownerBaseUrl.host)}</code>. The same-name repo uses the root path, and every other repo deploys under <code>/repo-name/</code> on that same subdomain.</p>`;
  const rootHint = target.isOwnerRoot
    ? `<p>Owner roots use the same-name repo convention, so this root domain maps to <code>${escapeHtml(target.repository)}</code>. Every other repo owned by <code>${escapeHtml(owner)}</code> deploys on this same subdomain under its repo path, such as <code>${escapeHtml(exampleRepoUrl)}</code> for <code>${escapeHtml(`${owner}/repo-name`)}</code>.</p>`
    : "";

  return `
      <section class="target hover-lift">
        <p class="eyebrow">Deploy target</p>
        <h2>Nothing is deployed here yet.</h2>
        <p>Nothing is deployed at <code>${escapeHtml(target.requestedUrl)}</code> yet.</p>
        ${ownerRouteHint}
        <p>To deploy to this domain and path, use <a href="${escapeHtml(target.repositoryUrl)}"><code>${escapeHtml(target.repository)}</code></a>.</p>
        <p>After it deploys, W7S will serve it at <a href="${escapeHtml(target.deployUrl)}">${escapeHtml(target.deployUrl)}</a>.</p>
        ${rootHint}
      </section>`;
};

export const landingHtml = (target?: DeployShowcaseTarget) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>W7S Cloud</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="preconnect" href="https://api.fontshare.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
    <link href="https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@800,900&display=swap" rel="stylesheet" />
    <style>
      :root {
        color-scheme: dark;
        --bg: #050505;
        --surface: #0f0f11;
        --surface-2: #16161a;
        --amber: #f59e0b;
        --amber-hover: #fcd34d;
        --text: #fafafa;
        --text-muted: #d4d4d8;
        --text-faint: #a1a1aa;
        --border: rgba(255, 255, 255, 0.1);
        --border-strong: rgba(255, 255, 255, 0.18);
        font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--text);
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        z-index: -2;
        background-image:
          linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
        background-size: 64px 64px;
      }
      body::after {
        content: "";
        position: fixed;
        inset: 0;
        z-index: -1;
        pointer-events: none;
        background: linear-gradient(to bottom, transparent 0%, transparent 62%, #050505 100%);
      }
      .noise {
        position: fixed;
        inset: 0;
        z-index: 1;
        pointer-events: none;
        opacity: 0.04;
        mix-blend-mode: screen;
        background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.9'/%3E%3C/svg%3E");
      }
      .shell {
        position: relative;
        z-index: 2;
        min-height: 100vh;
      }
      header {
        position: sticky;
        top: 0;
        z-index: 10;
        border-bottom: 1px solid var(--border);
        background: rgba(5, 5, 5, 0.86);
        backdrop-filter: blur(16px);
      }
      .nav {
        width: min(1400px, calc(100vw - 48px));
        height: 64px;
        margin: 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        color: var(--text);
        text-decoration: none;
      }
      .brand strong,
      h1,
      .stat strong {
        font-family: "Cabinet Grotesk", "Bricolage Grotesque", system-ui, sans-serif;
        font-weight: 900;
      }
      .brand strong {
        color: var(--text);
        font-size: 26px;
        line-height: 1;
      }
      .brand span {
        display: inline-flex;
        border: 1px solid var(--border);
        padding: 6px 8px;
        color: var(--text-faint);
        font-size: 10px;
        line-height: 1;
        letter-spacing: 0.25em;
        text-transform: uppercase;
      }
      nav {
        display: flex;
        align-items: center;
        gap: 22px;
      }
      nav a,
      .terminal-label,
      .eyebrow {
        color: var(--text-faint);
        font-size: 11px;
        letter-spacing: 0.2em;
        text-transform: uppercase;
      }
      nav a {
        text-decoration: none;
        transition: color 0.2s ease;
      }
      nav a:hover {
        color: var(--amber);
      }
      main {
        width: min(1400px, calc(100vw - 48px));
        margin: 0 auto;
        padding: 74px 0 72px;
      }
      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1.22fr) minmax(360px, 0.78fr);
        gap: 48px;
        align-items: start;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 9px;
        border: 1px solid var(--border);
        padding: 8px 10px;
        color: var(--text-muted);
        font-size: 10px;
        letter-spacing: 0.25em;
        text-transform: uppercase;
      }
      .badge::before {
        content: "";
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: var(--amber);
        box-shadow: 0 0 18px rgba(245, 158, 11, 0.75);
      }
      h1 {
        margin: 32px 0 0;
        max-width: 820px;
        color: var(--text);
        font-size: clamp(58px, 7.6vw, 118px);
        line-height: 0.9;
        letter-spacing: 0;
      }
      h1 em {
        color: var(--amber);
      }
      h2 {
        margin: 8px 0 14px;
        color: var(--text);
        font-size: 24px;
        line-height: 1.15;
        letter-spacing: 0;
      }
      p {
        margin: 0;
        color: var(--text-muted);
        font-size: 15px;
        line-height: 1.75;
      }
      .lede {
        max-width: 640px;
        margin-top: 30px;
      }
      .lede strong {
        color: var(--text);
        font-weight: 600;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 34px;
      }
      a {
        color: var(--amber);
        font-weight: 700;
        text-underline-offset: 4px;
      }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 48px;
        padding: 0 18px;
        border: 1px solid var(--border-strong);
        color: var(--text);
        text-decoration: none;
        font-size: 11px;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        transition:
          transform 0.2s ease,
          border-color 0.2s ease,
          color 0.2s ease,
          background-color 0.2s ease;
      }
      .button.primary {
        border-color: transparent;
        background: var(--amber);
        color: #000;
      }
      .button:hover {
        transform: translateY(-2px);
        border-color: rgba(245, 158, 11, 0.55);
        color: var(--amber);
      }
      .button.primary:hover {
        background: var(--amber-hover);
        color: #000;
      }
      code {
        border: 1px solid var(--border);
        padding: 2px 6px;
        background: rgba(255, 255, 255, 0.045);
        color: var(--text);
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 22px;
        max-width: 560px;
        margin-top: 42px;
      }
      .stat {
        border-left: 1px solid var(--border);
        padding-left: 16px;
      }
      .stat strong {
        display: block;
        color: var(--text);
        font-size: 32px;
        line-height: 1;
      }
      .stat span {
        display: block;
        margin-top: 8px;
        color: var(--text-faint);
        font-size: 10px;
        letter-spacing: 0.2em;
        line-height: 1.45;
        text-transform: uppercase;
      }
      .terminal {
        border: 1px solid var(--border);
        background: #000;
      }
      .terminal-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        min-height: 44px;
        padding: 0 16px;
        border-bottom: 1px solid var(--border);
        background: #0a0a0c;
      }
      .lights {
        display: inline-flex;
        gap: 8px;
      }
      .lights span {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #3f3f46;
      }
      pre {
        margin: 0;
        overflow-x: auto;
        padding: 20px;
        color: var(--text-muted);
      }
      pre code {
        border: 0;
        padding: 0;
        background: transparent;
        color: inherit;
        font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
        line-height: 1.75;
      }
      .workflow-action {
        color: var(--amber);
        font-weight: 800;
      }
      .target {
        margin-top: 24px;
        border: 1px solid var(--border);
        padding: 22px;
        background: rgba(15, 15, 17, 0.86);
      }
      .target p + p {
        margin-top: 10px;
      }
      .hover-lift {
        transition:
          transform 0.2s ease,
          border-color 0.2s ease,
          background-color 0.2s ease;
      }
      .hover-lift:hover {
        transform: translateY(-2px);
        border-color: rgba(245, 158, 11, 0.4);
      }
      .deploy-copy {
        margin-top: 18px;
        color: var(--text-faint);
        font-size: 13px;
      }
      .panel {
        margin-top: 72px;
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 16px;
      }
      .panel article {
        border: 1px solid var(--border);
        padding: 22px;
        background: rgba(15, 15, 17, 0.72);
      }
      .panel h3 {
        margin: 0 0 10px;
        color: var(--text);
        font-size: 15px;
        line-height: 1.35;
      }
      .panel p {
        color: var(--text-faint);
        font-size: 13px;
      }
      .legal-footer {
        width: min(1400px, calc(100vw - 48px));
        margin: 0 auto;
        padding: 0 0 30px;
        color: var(--text-faint);
        font-size: 11px;
      }
      .legal-footer-inner {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        border-top: 1px solid var(--border);
        padding-top: 20px;
      }
      .legal-footer nav {
        gap: 16px;
      }
      .legal-footer a {
        color: var(--text-faint);
        text-decoration: none;
      }
      .legal-footer a:hover {
        color: var(--amber);
      }
      @media (max-width: 980px) {
        .hero,
        .panel {
          grid-template-columns: 1fr;
        }
        .terminal {
          margin-top: 8px;
        }
      }
      @media (max-width: 680px) {
        .nav {
          width: min(100vw - 32px, 1400px);
        }
        nav {
          display: none;
        }
        main {
          width: min(100vw - 32px, 1400px);
          padding-top: 54px;
        }
        .legal-footer {
          width: min(100vw - 32px, 1400px);
        }
        .legal-footer nav {
          display: flex;
        }
        h1 {
          font-size: clamp(46px, 17vw, 72px);
        }
        .stats {
          grid-template-columns: 1fr;
          gap: 18px;
        }
        .button {
          width: 100%;
        }
        pre {
          padding: 16px;
        }
        pre code {
          font-size: 12px;
        }
      }
    </style>
  </head>
  <body>
    <div class="noise"></div>
    <div class="shell">
      <header>
        <div class="nav">
          <a class="brand" href="https://www.w7s.io/">
            <strong>W7S</strong>
            <span>Cloud hosted</span>
          </a>
          <nav aria-label="Primary">
            <a href="https://www.w7s.io/docs/">Docs</a>
            <a href="https://www.w7s.io/docs/pricing/">Pricing</a>
            <a href="https://github.com/w7s-io">GitHub</a>
          </nav>
        </div>
      </header>
      <main>
        <section class="hero">
          <div>
            <div class="badge">Open source GitHub-native deploys</div>
            <h1>The Cloud that <em>just works</em>.</h1>
            <p class="lede">
              <code>w7s.cloud</code> is the hosted W7S deploy environment. GitHub Actions builds your app; W7S ships the output to live environments and serves it at a public URL. <strong>Your deployment workflow is the control plane.</strong>
            </p>
            <div class="actions">
              <a class="button primary" href="https://www.w7s.io/docs/deploy-from-github/">Deploy from GitHub</a>
              <a class="button" href="https://www.w7s.io/docs/">Read the docs</a>
            </div>
            <div class="stats" aria-label="W7S summary">
              <div class="stat">
                <strong>W7S</strong>
                <span>Cloud hosted</span>
              </div>
              <div class="stat">
                <strong>No</strong>
                <span>account needed</span>
              </div>
              <div class="stat">
                <strong>Repo</strong>
                <span>owned deploys</span>
              </div>
            </div>
            ${deployTargetHtml(target)}
          </div>
          <div>
            <section class="terminal" aria-label="GitHub Actions deploy workflow">
              <div class="terminal-top">
                <div class="lights" aria-hidden="true">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
                <span class="terminal-label">.github/workflows/deploy.yml</span>
              </div>
              <pre><code>${deployWorkflowHtml()}</code></pre>
            </section>
            <p class="deploy-copy">Add this GitHub Actions workflow to any repo and push to GitHub. Manual runs deploy too; scheduled runs only check usage limits and update the warning issue. W7S verifies access with the repo's GitHub token and serves it at <code>&lt;owner&gt;.w7s.cloud/&lt;repo&gt;/</code>.</p>
          </div>
        </section>
        <section class="panel" aria-label="W7S capabilities">
          <article class="hover-lift">
            <h3>No dashboard required</h3>
            <p>Deploys start from GitHub Actions, so repository permissions and workflow history remain the source of truth.</p>
          </article>
          <article class="hover-lift">
            <h3>Frontend and backend</h3>
            <p>Ship static apps, JavaScript or TypeScript native backends, queues, schedules, workflows, storage, and custom domains.</p>
          </article>
          <article class="hover-lift">
            <h3>Usage-aware by default</h3>
            <p>W7S tracks usage and reports quota pressure back to the repository through the deploy workflow.</p>
          </article>
        </section>
      </main>
      <footer class="legal-footer">
        <div class="legal-footer-inner">
          <span>© 2026 W7S LLC</span>
          <nav aria-label="Legal">
            <a href="https://w7s.io/terms">Terms</a>
            <a href="https://w7s.io/privacy">Privacy</a>
          </nav>
        </div>
      </footer>
    </div>
  </body>
</html>`;
