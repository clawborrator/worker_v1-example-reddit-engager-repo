#!/usr/bin/env node
//
// reddit.js — Playwright wrapper used by the Reddit engager agent.
//
// Four subcommands, each prints JSON to stdout and exits:
//   auth-check                        verify cookies still log in
//   scroll-feed --count N --feed F    fetch posts from a feed
//   read-post <url>                   fetch a post body + comments
//   reply <permalink> --text "..."    post a comment, return its URL
//
// All browser work runs against OLD reddit (old.reddit.com). Its
// DOM is simpler, more stable, and far less anti-bot-aggressive
// than the new web UI. Same posts and comments, less Playwright
// headache.
//
// Cookies are loaded from /secrets/reddit.cookies.json
// (read-only mount). Expected format: top-level array of
// objects in Playwright's addCookies() shape. The "Cookie-Editor"
// browser extension exports this format directly.
//
// Selectors live in the SELECTORS object below — when Reddit
// changes their DOM (rare for old.reddit but it happens),
// updates land in one place.

'use strict';

// playwright-extra is a drop-in wrapper around playwright that
// supports plugins. The stealth plugin patches navigator.webdriver,
// chrome.runtime, the plugins array, WebGL fingerprint, canvas
// hash, language headers, and ~10 other detectable headless
// signals. Combined with `headless: false` under Xvfb (see
// CLAUDE.md, every node call is wrapped in `xvfb-run -a`), this
// extends session lifetime on Reddit and any other site doing
// fingerprint-based bot detection. Not bulletproof, but the
// default headless Chromium signature is the loudest single tell.
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────

const COOKIES_PATH = process.env.REDDIT_COOKIES_PATH
  || '/secrets/reddit.cookies.json';

const BASE = 'https://old.reddit.com';

// Where every-navigation screenshots land. In-repo so the agent
// commits them as part of its audit step and they show up on
// GitHub directly in the file browser. Operator-specified: a
// PNG per navigation, not just on failure. Builds a complete
// visual trace of what the engager saw at each step. Storage
// cost: ~500KB-2MB per PNG * ~5-10 PNGs per cycle * 4h cadence
// = ~50MB/day, ~18GB/year. Pruning is the operator's call.
const SCREENSHOTS_DIR = '/workspace/repo/data/screenshots';

// Selectors centralized so DOM updates are one-line fixes.
const SELECTORS = {
  // Logged-in indicator on any page (user dropdown in header).
  // Old reddit puts username in `<a class="user"><a>USERNAME</a></a>`.
  loggedInUser:        'span.user > a:not(.login-required)',

  // Post listing entries on feeds.
  feedPostThing:       'div.thing.link:not(.promoted)',
  feedPostTitle:       'a.title',
  feedPostSubreddit:   'a.subreddit',
  feedPostScore:       'div.score.unvoted',
  feedPostCommentsLink:'a.comments',

  // Single-post page.
  postSelf:            'div.entry div.usertext-body div.md',
  postAuthor:          'p.tagline a.author',

  // Comments tree.
  comment:             'div.comment',
  commentBody:         'div.entry div.usertext-body div.md',
  commentAuthor:       'p.tagline a.author',
  commentScore:        'span.score',
  commentPermalink:    'a.bylink',

  // Reply form (revealed when "reply" link is clicked).
  replyTrigger:        'ul.flat-list li a:has-text("reply")',
  replyTextarea:       'div.usertext-edit textarea[name="text"]',
  replySaveButton:     'button.save',

  // Anti-bot signals that indicate we shouldn't proceed.
  captchaIframe:       'iframe[src*="recaptcha"]',
  rateLimitNotice:     'div.error:has-text("you are doing that too much")',
};

// ─── Helpers ──────────────────────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function die(error, details) {
  emit({ ok: false, error, ...(details ? { details } : {}) });
  process.exit(1);
}

function loadCookies() {
  if (!fs.existsSync(COOKIES_PATH)) {
    die('cookies missing', `expected file at ${COOKIES_PATH}`);
  }
  const raw = fs.readFileSync(COOKIES_PATH, 'utf-8');
  let cookies;
  try {
    cookies = JSON.parse(raw);
  } catch (e) {
    die('cookies malformed', `not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(cookies)) {
    die('cookies malformed', 'top level must be an array');
  }
  // Playwright is strict about cookie shape. Normalize the few
  // fields different exporters disagree on.
  return cookies.map((c) => {
    const out = { ...c };
    if (typeof out.expires === 'string') out.expires = Number(out.expires);
    if (out.expirationDate && !out.expires) out.expires = Math.floor(out.expirationDate);
    if (out.session === true) delete out.expires;
    if (!out.domain) out.domain = '.reddit.com';
    if (!out.path) out.path = '/';
    // sameSite — Playwright accepts ONLY "Strict" | "Lax" | "None"
    // (case-sensitive). Different exporters emit different strings:
    //   Cookie-Editor (Chrome): "no_restriction" | "lax" | "strict" | "unspecified"
    //   EditThisCookie:         "no_restriction" | "lax" | "strict" | "unspecified"
    //   Firefox Cookie Quick:   "Strict" | "Lax" | "None" | "Unset"
    //   Raw devtools export:    sometimes missing entirely
    // Map to canonical form; if unmappable (or "unspecified"), drop
    // the field so Playwright applies its default rather than rejecting.
    const ss = (() => {
      if (out.sameSite == null) return null;
      const v = String(out.sameSite).toLowerCase();
      switch (v) {
        case 'strict':          return 'Strict';
        case 'lax':             return 'Lax';
        case 'none':            return 'None';
        case 'no_restriction':  return 'None';  // Cookie-Editor synonym
        default:                return null;    // "unspecified", "unset", etc.
      }
    })();
    if (ss) out.sameSite = ss;
    else delete out.sameSite;
    // Strip extension-specific bookkeeping fields Playwright doesn't accept.
    delete out.hostOnly;
    delete out.storeId;
    delete out.id;
    delete out.expirationDate;
    return out;
  });
}

async function newContext() {
  // headless: false plus Xvfb (see CLAUDE.md) removes the
  // headless-chromium fingerprint. The stealth plugin imported
  // at the top of this file patches the remaining common tells.
  // Requires DISPLAY env to be set, which xvfb-run does
  // automatically.
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const ctx = await browser.newContext({
    viewport:   { width: 1280, height: 900 },
    userAgent:  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale:     'en-US',
    timezoneId: 'America/New_York',
  });
  // Default per-action / per-locator timeout. Playwright defaults to
  // 30s which silently stretches read-post into minutes when a
  // single selector misses across many comments. We don't need 30s
  // to decide a selector missed on a page that's already rendered.
  // Navigation timeouts are set explicitly in gotoWithRetry (60s)
  // and are unaffected by this.
  ctx.setDefaultTimeout(5_000);
  await ctx.addCookies(loadCookies());
  return { browser, ctx };
}

// Counter to disambiguate screenshots from a single command run
// (multiple navigations in the same millisecond are common).
let navSeq = 0;

async function snapshotNav(page, contextTag, navLabel) {
  // Save a full-page PNG to the in-repo screenshots dir on every
  // navigation. The agent commits + pushes data/screenshots/ in
  // its audit step so screenshots show up directly in the GitHub
  // file browser. Returns the repo-relative path so the caller
  // can include it in JSON output.
  try {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  } catch {
    // continue; screenshot() below will surface the real error
  }
  navSeq++;
  const filename = `nav-${contextTag}-${String(navSeq).padStart(2, '0')}-${navLabel}-${Date.now()}.png`;
  const absolutePath = `${SCREENSHOTS_DIR}/${filename}`;
  const repoRelativePath = `data/screenshots/${filename}`;
  try {
    await page.screenshot({ path: absolutePath, fullPage: false });
    return repoRelativePath;
  } catch {
    return null;
  }
}

async function gotoWithRetry(page, url) {
  // page.goto with one cheap retry on TimeoutError. Reddit slows
  // responses to authenticated sessions immediately after a
  // successful POST (anti-spam pacing), so the second goto of a
  // cycle is the one that times out 3-4x more often than the
  // first. 60s + a 3s backoff retry catches the common case
  // without making the failure path absurdly long when the
  // session is genuinely throttled / down.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      return;
    } catch (e) {
      lastErr = e;
      const isTimeout = e?.name === 'TimeoutError' || /Timeout/i.test(e?.message ?? '');
      if (!isTimeout || attempt === 1) throw e;
      await page.waitForTimeout(3_000);
    }
  }
  throw lastErr;
}

async function assertNotChallenged(page) {
  // After any navigation, check for captcha / rate-limit pages.
  // If found, bail with a typed error so the agent can react.
  if (await page.locator(SELECTORS.captchaIframe).count() > 0) {
    die('captcha');
  }
  if (await page.locator(SELECTORS.rateLimitNotice).count() > 0) {
    die('rate_limited');
  }
}

function parseAgeHours(ageText) {
  // Reddit age strings: "3 hours ago", "2 days ago", "just now",
  // "submitted 5 minutes ago by u/foo", etc.
  if (!ageText) return null;
  const t = ageText.toLowerCase();
  if (t.includes('just now') || t.includes('a moment ago')) return 0;
  const m = t.match(/(\d+)\s*(minute|hour|day|month|year)s?\s*ago/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  switch (unit) {
    case 'minute': return n / 60;
    case 'hour':   return n;
    case 'day':    return n * 24;
    case 'month':  return n * 24 * 30;
    case 'year':   return n * 24 * 365;
    default:       return null;
  }
}

// ─── Subcommand: auth-check ───────────────────────────────────

async function cmdAuthCheck() {
  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  const screenshots = [];
  try {
    await gotoWithRetry(page, BASE + '/');
    screenshots.push(await snapshotNav(page, 'auth-check', 'post-goto'));
    await assertNotChallenged(page);
    const userLink = page.locator(SELECTORS.loggedInUser).first();
    const count = await userLink.count();
    if (count === 0) {
      emit({ ok: false, error: 'not logged in', hint: 'cookies likely expired; re-export from a logged-in browser', screenshots: screenshots.filter(Boolean) });
      process.exit(2);
    }
    const username = (await userLink.textContent())?.trim();
    emit({ ok: true, logged_in_as: username, screenshots: screenshots.filter(Boolean) });
  } catch (e) {
    emit({ ok: false, error: 'auth_check_failed', details: e.message, screenshots: screenshots.filter(Boolean) });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ─── Subcommand: scroll-feed ──────────────────────────────────

async function cmdScrollFeed(args) {
  const count = parseInt(args.count || '20', 10);
  const feedArg = args.feed || 'home';
  let url = BASE + '/';
  if (feedArg === 'all') url = BASE + '/r/all/';
  else if (feedArg.startsWith('sub:')) {
    url = `${BASE}/r/${feedArg.slice(4)}/`;
  } else if (feedArg !== 'home') {
    die('bad_feed', `unknown feed "${feedArg}" — use home | all | sub:<name>`);
  }

  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  const screenshots = [];
  try {
    await gotoWithRetry(page, url);
    screenshots.push(await snapshotNav(page, 'scroll-feed', 'post-goto'));
    await assertNotChallenged(page);

    // Scroll until we have at least `count` posts visible, or hit
    // 5 scroll attempts. Old reddit paginates, so we may need to
    // click the "next" link instead.
    let posts = [];
    for (let scrollPass = 0; scrollPass < 5; scrollPass++) {
      posts = await page.locator(SELECTORS.feedPostThing).all();
      if (posts.length >= count) break;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(800);
      screenshots.push(await snapshotNav(page, 'scroll-feed', `after-scroll-${scrollPass + 1}`));
    }

    const out = [];
    for (const post of posts.slice(0, count)) {
      try {
        const id = await post.getAttribute('data-fullname');
        const title = (await post.locator(SELECTORS.feedPostTitle).first().textContent())?.trim();
        const subreddit = (await post.locator(SELECTORS.feedPostSubreddit).first().textContent())?.trim();
        const scoreText = (await post.locator(SELECTORS.feedPostScore).first().textContent())?.trim();
        const score = scoreText && scoreText !== '•' ? parseInt(scoreText, 10) : null;
        const commentsHref = await post.locator(SELECTORS.feedPostCommentsLink).first().getAttribute('href');
        const numComments = await post.getAttribute('data-comments-count');
        const ageText = await post.locator('time').first().getAttribute('title').catch(() => null);
        const ageHours = await post.locator('time').first().getAttribute('datetime').then((iso) => {
          if (!iso) return null;
          return Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
        }).catch(() => null);
        const isLink = (await post.getAttribute('data-domain')) !== 'self.' + (subreddit || '');
        // Self-text excerpt only available on the post page, not feed.
        out.push({
          id,
          title,
          subreddit: subreddit ? subreddit.replace(/^\/?r\//, '') : null,
          url: commentsHref?.startsWith('http') ? commentsHref : BASE + commentsHref,
          score,
          num_comments: numComments ? parseInt(numComments, 10) : null,
          age_hours: ageHours,
          age_text: ageText,
          is_link: isLink,
        });
      } catch (e) {
        // Skip malformed post listings rather than failing the whole
        // command — Reddit occasionally injects promoted slots, ads,
        // recommendation widgets that don't match our selectors cleanly.
        continue;
      }
    }
    emit({ ok: true, feed: feedArg, posts: out, screenshots: screenshots.filter(Boolean) });
  } catch (e) {
    emit({ ok: false, error: 'scroll_feed_failed', details: e.message, screenshots: screenshots.filter(Boolean) });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ─── Subcommand: read-post ────────────────────────────────────

async function cmdReadPost(postUrl) {
  if (!postUrl) die('missing_arg', 'read-post requires a post URL');

  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  const screenshots = [];
  try {
    await gotoWithRetry(page, postUrl);
    screenshots.push(await snapshotNav(page, 'read-post', 'post-goto'));
    await assertNotChallenged(page);

    // Post body
    const postContainer = page.locator('div.sitetable.linklisting > div.thing.link').first();
    const id = await postContainer.getAttribute('data-fullname');
    const title = (await postContainer.locator('a.title').first().textContent())?.trim();
    const subredditAttr = await postContainer.getAttribute('data-subreddit');
    const author = (await postContainer.locator(SELECTORS.postAuthor).first().textContent().catch(() => null))?.trim();
    const selfText = (await postContainer.locator(SELECTORS.postSelf).first().textContent().catch(() => ''))?.trim();

    // Comments — expand any collapsed long threads if possible
    // (best-effort; some "load more" links require multiple clicks).
    const comments = [];
    const commentThings = await page.locator(SELECTORS.comment).all();
    for (const c of commentThings.slice(0, 100)) {
      try {
        const cId = await c.getAttribute('data-fullname');
        const cAuthor = (await c.locator(SELECTORS.commentAuthor).first().textContent().catch(() => null))?.trim();
        const cBody = (await c.locator(SELECTORS.commentBody).first().textContent().catch(() => ''))?.trim();
        const cScoreText = (await c.locator(SELECTORS.commentScore).first().textContent().catch(() => null))?.trim();
        const cScore = cScoreText ? parseInt(cScoreText, 10) || null : null;
        const cPermalink = await c.locator(SELECTORS.commentPermalink).first().getAttribute('href').catch(() => null);
        const cParentId = await c.getAttribute('data-parent-fullname');
        const cAgeIso = await c.locator('time').first().getAttribute('datetime').catch(() => null);
        const cAgeHours = cAgeIso
          ? Math.round((Date.now() - new Date(cAgeIso).getTime()) / 3_600_000)
          : null;
        // Depth from CSS class — old reddit nests with margin classes
        // but data-depth is the cleanest signal when present.
        const depthAttr = await c.getAttribute('data-depth');
        const depth = depthAttr ? parseInt(depthAttr, 10) : 0;
        if (!cId || !cAuthor || !cBody) continue;
        comments.push({
          id: cId,
          author: cAuthor,
          body: cBody,
          score: cScore,
          age_hours: cAgeHours,
          permalink: cPermalink?.startsWith('http') ? cPermalink : BASE + cPermalink,
          depth,
          parent_id: cParentId,
        });
      } catch (e) {
        continue;
      }
    }

    emit({
      ok: true,
      post: { id, title, subreddit: subredditAttr, author, self_text: selfText, url: postUrl },
      comments,
      screenshots: screenshots.filter(Boolean),
    });
  } catch (e) {
    emit({ ok: false, error: 'read_post_failed', details: e.message, screenshots: screenshots.filter(Boolean) });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ─── Subcommand: reply ────────────────────────────────────────

async function cmdReply(permalink, args) {
  if (!permalink) die('missing_arg', 'reply requires a comment permalink');
  const text = args.text;
  if (!text || !text.trim()) die('missing_arg', 'reply requires --text "..."');

  // Structural ban on em + en dashes. The playbook step 6a forbids
  // them but the model violated this rule in ~54% of audited replies,
  // so the prompt-level rule was insufficient. Enforcing at the tool
  // boundary means the engager literally cannot post a reply that
  // contains one. The error code is documented in the playbook's
  // step 6c so the engager knows to rewrite + retry.
  const EM_DASH = '—';
  const EN_DASH = '–';
  if (text.includes(EM_DASH) || text.includes(EN_DASH)) {
    die('forbidden_chars',
        'reply text contains an em dash (\\u2014) or en dash (\\u2013); ' +
        'rewrite without these characters per CLAUDE.md step 6a. ' +
        'Use periods, semicolons, colons, parentheses, or commas instead.');
  }

  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  const screenshots = [];
  try {
    await gotoWithRetry(page, permalink);
    screenshots.push(await snapshotNav(page, 'reply', 'post-goto'));
    await assertNotChallenged(page);

    // Find the highlighted comment (Reddit puts ?context= on
    // permalinks that pins one comment). If multiple match, take
    // the one with the matching id from the URL fragment.
    const targetId = (permalink.match(/\/comments\/[a-z0-9]+\/[^/]+\/([a-z0-9]+)/) || [])[1];
    let targetCommentLoc;
    if (targetId) {
      targetCommentLoc = page.locator(`div.comment[data-fullname="t1_${targetId}"]`).first();
    } else {
      targetCommentLoc = page.locator('div.comment').first();
    }
    if (await targetCommentLoc.count() === 0) {
      die('comment_not_found', 'no comment matched the permalink target');
    }

    // Click the "reply" link inside the comment's action menu.
    const replyLink = targetCommentLoc.locator(SELECTORS.replyTrigger).first();
    if (await replyLink.count() === 0) {
      die('comment_form_not_found', 'no reply trigger — comment locked / archived / banned / Reddit DOM changed');
    }
    await replyLink.click();
    screenshots.push(await snapshotNav(page, 'reply', 'after-click-reply'));

    // The textarea should now be visible nested inside the comment.
    const textarea = targetCommentLoc.locator(SELECTORS.replyTextarea).first();
    await textarea.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
      die('comment_form_not_found', 'reply textarea did not appear after clicking reply');
    });

    // Type with small random delays — slightly slower than instant
    // fill, which helps avoid trivial bot detection.
    await textarea.fill(text);
    screenshots.push(await snapshotNav(page, 'reply', 'after-fill'));

    // Click save.
    const saveBtn = targetCommentLoc.locator(SELECTORS.replySaveButton).first();
    await saveBtn.click();
    screenshots.push(await snapshotNav(page, 'reply', 'after-submit'));

    // Wait for the new comment to appear. Old reddit injects it
    // inline as a child of the target comment after a brief AJAX
    // round-trip. If captcha or rate-limit happens here, that's
    // the only post-click failure mode we can detect — Reddit
    // doesn't surface "your comment was filtered" anywhere
    // machine-readable. assertNotChallenged() throws via die() on
    // those, so if we get past it the comment is almost
    // certainly live.
    await page.waitForTimeout(2_500);
    await assertNotChallenged(page);

    // Best-effort: find the freshly-posted comment's permalink for
    // the audit log. This is metadata, NOT a success signal. The
    // reply is already posted at this point — see comment above —
    // so a failure to extract the URL must not flip the whole
    // command to {ok: false}, which would cause the agent to
    // think it should retry (it would, posting a duplicate). We
    // emit {ok: true, comment_url: null} on extraction failure
    // and let the audit's target_comment_url carry the trail.
    const me = (await page.locator(SELECTORS.loggedInUser).first().textContent().catch(() => null))?.trim();
    let newCommentUrl = null;
    let urlExtractionError = null;
    if (me) {
      try {
        // CSS :has() lets us select comment containers whose
        // tagline author text matches the logged-in user. .last()
        // picks the most recently rendered one (Reddit appends
        // new comments as the deepest sibling under targetCommentLoc).
        // Using Locator-chain end-to-end (no evaluateHandle +
        // ElementHandle dance) avoids the API mismatch that bit us
        // pre-fix.
        const myCommentLoc = targetCommentLoc
          .locator(`div.comment:has(> div.entry p.tagline > a.author:text-is("${me}"))`)
          .last();
        const href = await myCommentLoc
          .locator(SELECTORS.commentPermalink)
          .first()
          .getAttribute('href', { timeout: 3_000 });
        newCommentUrl = href?.startsWith('http') ? href : (href ? BASE + href : null);
      } catch (e) {
        urlExtractionError = e.message;
      }
    }

    emit({
      ok: true,
      comment_url: newCommentUrl,
      note: newCommentUrl
        ? null
        : `posted (assertNotChallenged passed post-click) but URL extraction failed: ${urlExtractionError ?? 'no match for own author in tree'} — audit via target_comment_url`,
      screenshots: screenshots.filter(Boolean),
    });
  } catch (e) {
    // Only true reply failures (form not found, captcha during
    // submit, rate-limit detected by assertNotChallenged) reach
    // here. URL-extraction failures are caught above and emit
    // ok:true with a null comment_url + diagnostic note.
    emit({ ok: false, error: 'reply_failed', details: e.message, screenshots: screenshots.filter(Boolean) });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ─── CLI dispatch ─────────────────────────────────────────────

function parseArgs(argv) {
  // Very small flag parser — `--key value` and `--key=value`.
  // Positional args returned as `_`.
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        out[a.slice(2)] = argv[i + 1];
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// Per-command overall wall-clock cap. Even with the 5s per-locator
// default and 60s navigation timeouts, a hung Chromium subprocess
// can stall the whole run silently. Race the command against this
// timeout; on expiry, emit a typed error and bail. The engager
// playbook treats this as a skip-the-cycle signal.
const COMMAND_TIMEOUT_MS = {
  'auth-check':  90_000,
  'scroll-feed': 150_000,
  'read-post':   150_000,
  'reply':       180_000,
};

function withTimeout(promise, ms, cmd) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const err = new Error(`command_timeout: ${cmd} exceeded ${ms}ms`);
        err.code = 'command_timeout';
        reject(err);
      }, ms).unref(); // unref so a fast-finishing promise doesn't keep node alive
    }),
  ]);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  const timeoutMs = COMMAND_TIMEOUT_MS[cmd] ?? 150_000;

  const dispatch = (() => {
    switch (cmd) {
      case 'auth-check':  return cmdAuthCheck();
      case 'scroll-feed': return cmdScrollFeed(args);
      case 'read-post':   return cmdReadPost(args._[0]);
      case 'reply':       return cmdReply(args._[0], args);
      default:
        emit({
          ok: false,
          error: 'unknown_command',
          usage: [
            'reddit.js auth-check',
            'reddit.js scroll-feed --count 20 --feed home|all|sub:<name>',
            'reddit.js read-post <post-url>',
            'reddit.js reply <comment-permalink> --text "..."',
          ],
        });
        process.exit(1);
    }
  })();

  try {
    await withTimeout(dispatch, timeoutMs, cmd);
  } catch (e) {
    if (e?.code === 'command_timeout') {
      emit({ ok: false, error: 'command_timeout', details: e.message });
      process.exit(1);
    }
    throw e;
  }
}

main().catch((e) => {
  die('uncaught', e.stack || e.message || String(e));
});
